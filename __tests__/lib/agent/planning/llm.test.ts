import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { aggregate } from "@/lib/agent/planning/llm"
import type { DDReport } from "@/lib/agent/types"
import type { PerspectiveReport } from "@/lib/agent/planning/types"

const mockCreate = vi.fn()

vi.mock("openai", () => {
  const MockOpenAI = function () {
    return { chat: { completions: { create: mockCreate } } }
  }
  return { default: MockOpenAI }
})

vi.mock("@/lib/agent/shared/llm-client", () => {
  let client: unknown = null
  return {
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    DEEPSEEK_THINK_MODEL: "deepseek-v4-pro",
    getClient: () => {
      if (!process.env.DEEPSEEK_API_KEY) return null
      if (!client) client = { chat: { completions: { create: mockCreate } } }
      return client
    },
  }
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

describe("aggregate", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    mockCreate.mockReset()
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })

  const reports: PerspectiveReport[] = [
    {
      perspective: "conservative",
      score: 60,
      confidence: 55,
      side: "long",
      entry_price: 64000,
      signals: [],
      dataSources: ["hyperliquid"],
      reasoning: "Cautious long",
      iterations: 2,
      conclusion: "Small long",
      errors: [],
      suggested_stop_loss: 62000,
      suggested_take_profit: 70000,
      suggested_position_size_usdc: 500,
      risk_flags: [],
    },
    {
      perspective: "balance",
      score: 70,
      confidence: 65,
      side: "long",
      entry_price: 64000,
      signals: [],
      dataSources: ["hyperliquid"],
      reasoning: "Balanced long",
      iterations: 2,
      conclusion: "Moderate long",
      errors: [],
      suggested_stop_loss: 61000,
      suggested_take_profit: 72000,
      suggested_position_size_usdc: 800,
      risk_flags: [],
    },
    {
      perspective: "aggressive",
      score: 80,
      confidence: 75,
      side: "long",
      entry_price: 64000,
      signals: [],
      dataSources: ["hyperliquid"],
      reasoning: "Strong long",
      iterations: 2,
      conclusion: "Full long",
      errors: [],
      suggested_stop_loss: 60000,
      suggested_take_profit: 75000,
      suggested_position_size_usdc: 1200,
      risk_flags: [],
    },
  ]

  const validAggregationJson = {
    side: "long",
    thesis: "BTC trending up",
    reasoning: "All perspectives aligned",
    risk_flags_text: "Funding elevated but within norms",
    consensus_alignment: 80,
    contradictions: [],
  }

  it("returns sanitized narrative aggregation on valid LLM JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validAggregationJson) } }],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 10 })
    expect(result).not.toBeNull()
    expect(result!.side).toBe("long")
    expect(result!.thesis).toBe("BTC trending up")
    expect(result!.reasoning).toBe("All perspectives aligned")
    expect(result!.risk_flags_text).toBe("Funding elevated but within norms")
    expect(result!.consensus_alignment).toBe(80)
    expect(result!.contradictions).toEqual([])
  })

  it("drops every money number the LLM invents (zod strips unknown keys)", async () => {
    // reason: the schema has no entry/SL/TP/size/leverage/confidence fields —
    // any numeric value the model hallucinates is silently stripped, so an
    // LLM-guessed number can never survive into the aggregation.
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validAggregationJson,
              entry_price: 64000,
              stop_loss: 61000,
              take_profit: 72000,
              position_size_usdc: 800,
              leverage: 5,
              confidence_score: 72,
              confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
              profit_feasible: true,
            }),
          },
        },
      ],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).not.toBeNull()
    expect(result!).not.toHaveProperty("entry_price")
    expect(result!).not.toHaveProperty("stop_loss")
    expect(result!).not.toHaveProperty("take_profit")
    expect(result!).not.toHaveProperty("position_size_usdc")
    expect(result!).not.toHaveProperty("confidence_score")
    expect(result!).not.toHaveProperty("profit_feasible")
  })

  it("preserves no_trade outcome with reason", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validAggregationJson,
              side: "no_trade",
              no_trade_reason: "Funding overheated",
            }),
          },
        },
      ],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.side).toBe("no_trade")
    expect(result!.no_trade_reason).toBe("Funding overheated")
  })

  it("appends factor coverage context to the user message", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validAggregationJson) } }],
    })

    await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })

    const [reqArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>]
    const messages = reqArgs.messages as Array<{ role: string; content: string }>
    const userPayload = JSON.parse(messages[1].content)
    expect(userPayload.factorCoverageContext).toContain("covers 4 factors")
  })

  it("clamps consensus_alignment to 0-100", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validAggregationJson,
              consensus_alignment: 150,
            }),
          },
        },
      ],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.consensus_alignment).toBe(100)
  })

  it("applies defaults for missing optional fields", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ side: "long" }) } }],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.thesis).toBe("")
    expect(result!.reasoning).toBe("")
    expect(result!.risk_flags_text).toBe("")
    expect(result!.contradictions).toEqual([])
    expect(result!.consensus_alignment).toBe(0)
  })

  it("returns null when side is not a valid enum value", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ ...validAggregationJson, side: "buy" }) } }],
    })
    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toBeNull()
  })

  it("returns null on invalid JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "not json{{{" } }],
    })
    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toBeNull()
  })

  it("returns null on API error", async () => {
    mockCreate.mockRejectedValue(new Error("boom"))
    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toBeNull()
  })

  it("returns null when no API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
