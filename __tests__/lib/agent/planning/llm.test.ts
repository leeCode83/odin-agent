import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { generatePerspective, aggregatePerspectives } from "@/lib/agent/planning/llm"
import type { DDReport, GraphPattern } from "@/lib/agent/types"
import type { Perspective, PerspectiveResult } from "@/lib/agent/planning/types"

const mockCreate = vi.fn()

vi.mock("openai", () => {
  const MockOpenAI = function () {
    return { chat: { completions: { create: mockCreate } } }
  }
  return { default: MockOpenAI }
})

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "large-cap",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish trend intact", signals: ["RSI > 60", "MA crossover"] },
    onchain: { score: 60, summary: "Steady accumulation", signals: ["Exchange outflows"] },
    sentiment: { score: 55, summary: "Neutral sentiment", signals: ["Funding rate neutral"] },
    fundamental: { score: 80, summary: "Strong fundamentals", signals: ["Hashrate ATH"] },
  },
  aggregated_thesis: "BTC has moderate upside potential",
  confidence_score: 65,
  risk_flags: ["Regulatory uncertainty"],
  errors: [],
}

const mockGraphPatterns: GraphPattern[] = [
  { pattern: "cup-handle", outcome: "bullish", frequency: 3 },
  { pattern: "double-top", outcome: "bearish", frequency: 1 },
]

const validPerspectiveJson = {
  thesis: "Bullish on BTC",
  confidence: 75,
  side: "long",
  leverage: 5,
  reasoning: "Strong technical setup",
  signals: ["uptrend", "high volume"],
}

describe("generatePerspective", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    mockCreate.mockReset()
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })

  it("returns parsed PerspectiveResult when LLM responds with valid JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify(validPerspectiveJson),
            reasoning_content: "Technical analysis shows strong uptrend",
          },
        },
      ],
    })

    const result = await generatePerspective("balance", mockDDReport, mockGraphPatterns)
    expect(result).not.toBeNull()
    expect(result!.thesis).toBe("Bullish on BTC")
    expect(result!.confidence).toBe(75)
    expect(result!.side).toBe("long")
    expect(result!.leverage).toBe(5)
    expect(result!.reasoning).toBe("Strong technical setup")
    expect(result!.signals).toEqual(["uptrend", "high volume"])
  })

  it("returns null when LLM responds with invalid JSON (after retry)", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "not valid json",
            reasoning_content: "",
          },
        },
      ],
    })

    const result = await generatePerspective("balance", mockDDReport, mockGraphPatterns)
    expect(result).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("includes reasoningContent from LLM response", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify(validPerspectiveJson),
            reasoning_content: "Deep reasoning about BTC market conditions",
          },
        },
      ],
    })

    const result = await generatePerspective("balance", mockDDReport, mockGraphPatterns)
    expect(result!.reasoningContent).toBe("Deep reasoning about BTC market conditions")
  })

  it("returns null when no API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await generatePerspective("balance", mockDDReport, mockGraphPatterns)
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe("aggregatePerspectives", () => {
  const mockResults: PerspectiveResult[] = [
    {
      perspective: "conservative" as Perspective,
      thesis: "BTC cautious long",
      confidence: 45,
      side: "long",
      leverage: 2,
      reasoning: "Trend ok but weak conviction",
      reasoningContent: "",
      signals: ["MA crossover"],
    },
    {
      perspective: "balance" as Perspective,
      thesis: "BTC moderate long",
      confidence: 65,
      side: "long",
      leverage: 5,
      reasoning: "Balance of factors positive",
      reasoningContent: "",
      signals: ["RSI > 60", "Exchange outflows"],
    },
    {
      perspective: "aggressive" as Perspective,
      thesis: "BTC strong long",
      confidence: 85,
      side: "long",
      leverage: 10,
      reasoning: "Strong momentum, breakout pattern",
      reasoningContent: "",
      signals: ["Breakout above resistance"],
    },
  ]

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    mockCreate.mockReset()
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })

  it("returns AggregatedReasoning with thesis, confidence, reasoning", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              thesis: "Aggregated thesis",
              confidence_score: 72,
              confidence_breakdown: {
                factor_alignment: 70,
                historical_match: 50,
                signal_strength: 80,
              },
              direction: "long",
              reasoning: "Consensus across perspectives",
            }),
          },
        },
      ],
    })

    const result = await aggregatePerspectives(mockResults, mockDDReport)
    expect(result).not.toBeNull()
    expect(result!.thesis).toBe("Aggregated thesis")
    expect(result!.confidence).toEqual({
      factor_alignment: 70,
      historical_match: 50,
      signal_strength: 80,
    })
    expect(result!.reasoning).toBe("Consensus across perspectives")
  })

  it("returns null on parse failure", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "broken json{{{",
          },
        },
      ],
    })

    const result = await aggregatePerspectives(mockResults, mockDDReport)
    expect(result).toBeNull()
  })

  it("returns null when no API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await aggregatePerspectives(mockResults, mockDDReport)
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
