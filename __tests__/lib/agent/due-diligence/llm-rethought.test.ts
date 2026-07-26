import { describe, it, expect, vi, beforeEach } from "vitest"
import { think, plan, rePlan, aggregate } from "@/lib/agent/due-diligence/llm"
import { REACT_SYSTEM_PROMPT, PLAN_PROMPT, REPLAN_PROMPT, AGGREGATE_PROMPT } from "@/lib/agent/due-diligence/prompts"
import { z } from "zod"

vi.mock("openai", () => {
  const mockCreate = vi.fn()
  return {
    default: vi.fn(function () {
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      }
    }),
  }
})

import OpenAI from "openai"
const mockClient = vi.mocked(new OpenAI({ apiKey: "test" }))
const mockCreate = mockClient.chat.completions.create as ReturnType<typeof vi.fn>

describe("think()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns parsed SubAgentThought on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return",
        score: 75,
        confidence: 80,
        signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
        reasoning: "Analysis complete",
        conclusion: "Bullish momentum",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(75)
      expect(result.confidence).toBe(80)
      expect(result.signals).toHaveLength(1)
      expect(result.signals[0]).toHaveProperty("name", "RSI")
    }
  })

  it("returns parsed tool_call SubAgentThought", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "tool_call",
        toolName: "get_price",
        params: { asset: "BTC" },
        reasoning: "Need price data",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("tool_call")
    if (result.action === "tool_call") {
      expect(result.toolName).toBe("get_price")
      expect(result.params).toEqual({ asset: "BTC" })
    }
  })

  it("returns fallback SubAgentThought when LLM fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
  })

  it("returns fallback on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(0)
    }
  })

  it("returns fallback on JSON parse failure", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
  })
})

describe("plan()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns SubagentPlan array on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Analyze BTC market data for momentum and trend", priority: 1 },
        { factor: "onchain", instruction: "Check on-chain metrics for BTC", priority: 2 },
      ]) } }],
    })

    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical", "onchain"] },
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toContain("Analyze BTC")
    expect(result[0].priority).toBe(1)
    expect(result[1].factor).toBe("onchain")
  })

  it("returns empty array on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical"] },
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical"] },
    })
    expect(result).toEqual([])
  })
})

describe("rePlan()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns SubagentPlan array for low-confidence factors", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Re-analyze with additional price data and trend indicators", priority: 1 },
      ]) } }],
    })

    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toHaveLength(1)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toContain("Re-analyze")
    expect(result[0].priority).toBe(1)
  })

  it("returns empty array on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })
})

describe("aggregate()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns valid aggregation on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        thesis: "BTC is bullish overall across technical and on-chain factors",
        crossValidation: {
          pairs: [{ factorA: "technical", factorB: "onchain", alignment: 80, note: "Both indicate strength" }],
          overallAlignment: 80,
          contradictions: [],
        },
        risks: [{ factor: "technical", description: "RSI overbought", severity: "medium" }],
        catalysts: [{ factor: "onchain", description: "Exchange outflows rising", impact: "high" }],
        summary: "BTC looks strong across all analyzed factors with manageable risk.",
      }) } }],
    })

    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result.thesis).toBe("BTC is bullish overall across technical and on-chain factors")
    expect(result.crossValidation.overallAlignment).toBe(80)
    expect(result.crossValidation.pairs).toHaveLength(1)
    expect(result.crossValidation.pairs[0].factorA).toBe("technical")
    expect(result.crossValidation.pairs[0].alignment).toBe(80)
    expect(result.risks).toHaveLength(1)
    expect(result.risks[0].severity).toBe("medium")
    expect(result.catalysts).toHaveLength(1)
    expect(result.catalysts[0].impact).toBe("high")
    expect(result.summary).toBeTruthy()
  })

  it("returns default on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result.thesis).toBe("Aggregation failed")
    expect(result.crossValidation.overallAlignment).toBe(0)
    expect(result.risks).toEqual([])
    expect(result.catalysts).toEqual([])
  })

  it("returns default on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result.thesis).toBe("LLM unavailable")
    expect(result.crossValidation.overallAlignment).toBe(0)
  })
})

describe("REACT_SYSTEM_PROMPT", () => {
  const tools = {
    get_price: {
      name: "get_price",
      description: "Get the current price for an asset",
      parameters: z.object({ asset: z.string() }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
    get_trend: {
      name: "get_trend",
      description: "Get the current market trend direction",
      parameters: z.object({}),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
  }

  it("includes tool names and descriptions for given tools", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("get_price")
    expect(prompt).toContain("get_trend")
    expect(prompt).toContain("Get the current price for an asset")
    expect(prompt).toContain("Get the current market trend direction")
  })

  it("includes parameter hints in tool descriptions", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("{asset}")
    expect(prompt).toContain("{}")
  })

  it("includes the instruction in the prompt", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("Analyze BTC market data")
  })

  it("includes the factor name in the prompt", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("technical")
  })
})

describe("PROMPT constants exist", () => {
  it("PLAN_PROMPT is defined and non-empty", () => {
    expect(PLAN_PROMPT).toBeTruthy()
    expect(PLAN_PROMPT.length).toBeGreaterThan(50)
  })

  it("REPLAN_PROMPT is defined and non-empty", () => {
    expect(REPLAN_PROMPT).toBeTruthy()
    expect(REPLAN_PROMPT.length).toBeGreaterThan(50)
  })

  it("AGGREGATE_PROMPT is defined and non-empty", () => {
    expect(AGGREGATE_PROMPT).toBeTruthy()
    expect(AGGREGATE_PROMPT.length).toBeGreaterThan(50)
  })
})
