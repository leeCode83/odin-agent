import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { plan, rePlan, aggregate } from "@/lib/agent/planning/llm"
import type { DDReport } from "@/lib/agent/types"
import type { PerspectiveReport } from "@/lib/agent/planning/types"

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

describe("plan", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    mockCreate.mockReset()
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })

  it("returns sanitized planning plans from valid LLM JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subagents: [
                { perspective: "conservative", instruction: "Be cautious", priority: 1 },
                { perspective: "balance", instruction: "Weigh both sides", priority: 2 },
                { perspective: "aggressive", instruction: "Seek upside", priority: 3 },
              ],
            }),
          },
        },
      ],
    })

    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ perspective: "conservative", instruction: "Be cautious", priority: 1 })
    expect(result[2].perspective).toBe("aggressive")
  })

  it("uses deepseek-v4-pro thinking config (no temperature, 60s timeout, retry 1)", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ subagents: [] }) } }],
    })

    await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const [reqArgs, reqOptions] = mockCreate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(reqArgs.model).toBe("deepseek-v4-pro")
    expect(reqArgs.max_tokens).toBe(8192)
    expect(reqArgs.response_format).toEqual({ type: "json_object" })
    expect(reqArgs).not.toHaveProperty("temperature")
    expect(reqArgs.thinking).toEqual({ type: "enabled" })
    expect(reqArgs.reasoning_effort).toBe("high")
    expect(reqOptions.timeout).toBe(60_000)
    expect(reqOptions.maxRetries).toBe(1)
  })

  it("sends ddReport and targetProfitPercent in the user message", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ subagents: [] }) } }],
    })

    await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })

    const [reqArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>]
    const messages = reqArgs.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe("system")
    const userPayload = JSON.parse(messages[1].content)
    expect(userPayload.ddReport.asset).toBe("BTC")
    expect(userPayload.targetProfitPercent).toBe(100)
  })

  it("dedupes repeated perspectives and clamps priority to 1-3", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subagents: [
                { perspective: "conservative", instruction: "First", priority: 0 },
                { perspective: "conservative", instruction: "Duplicate", priority: 1 },
                { perspective: "balance", instruction: "OK", priority: 9 },
                { perspective: "aggressive", instruction: "OK", priority: 2.6 },
              ],
            }),
          },
        },
      ],
    })

    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toHaveLength(3)
    expect(result[0].instruction).toBe("First")
    expect(result[0].priority).toBe(1)
    expect(result[1].priority).toBe(3)
    expect(result[2].priority).toBe(3)
  })

  it("drops invalid perspectives and non-object items", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subagents: [
                { perspective: "meme", instruction: "Bad", priority: 1 },
                "garbage",
                { perspective: "conservative", instruction: "OK", priority: 1 },
              ],
            }),
          },
        },
      ],
    })

    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toHaveLength(1)
    expect(result[0].perspective).toBe("conservative")
  })

  it("returns [] on API error with console.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    mockCreate.mockRejectedValue(new Error("boom"))
    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("returns [] on invalid JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "not json{{{" } }],
    })
    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toEqual([])
  })

  it("returns [] when no API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await plan({ ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe("rePlan", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    mockCreate.mockReset()
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
  })

  const previousReports: PerspectiveReport[] = [
    {
      perspective: "conservative",
      score: 30,
      confidence: 25,
      side: "no_trade",
      entry_price: 0,
      signals: [],
      dataSources: [],
      reasoning: "Flat market",
      iterations: 3,
      conclusion: "No setup",
      errors: [],
      suggested_stop_loss: 0,
      suggested_take_profit: 0,
      suggested_leverage: 0,
      suggested_position_size_usdc: 0,
      risk_flags: [],
    },
  ]

  it("returns targeted plans for low-consensus perspectives", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subagents: [
                { perspective: "conservative", instruction: "Re-check funding regime", priority: 1 },
              ],
            }),
          },
        },
      ],
    })

    const result = await rePlan({
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      lowConsensusPerspectives: ["conservative"],
      previousReports,
    })
    expect(result).toHaveLength(1)
    expect(result[0].perspective).toBe("conservative")
    expect(result[0].instruction).toContain("funding")
  })

  it("sends low-consensus perspectives and previous reports in the user message", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ subagents: [] }) } }],
    })

    await rePlan({
      ddReport: mockDDReport,
      targetProfitPercent: 50,
      lowConsensusPerspectives: ["conservative", "balance"],
      previousReports,
    })

    const [reqArgs] = mockCreate.mock.calls[0] as [Record<string, unknown>]
    const messages = reqArgs.messages as Array<{ role: string; content: string }>
    const userPayload = JSON.parse(messages[1].content)
    expect(userPayload.lowConsensusPerspectives).toEqual(["conservative", "balance"])
    expect(userPayload.previousReports).toHaveLength(1)
    expect(userPayload.ddReport.asset).toBe("BTC")
    expect(userPayload.targetProfitPercent).toBe(50)
  })

  it("returns [] on failure", async () => {
    mockCreate.mockRejectedValue(new Error("boom"))
    const result = await rePlan({
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      lowConsensusPerspectives: ["conservative"],
      previousReports,
    })
    expect(result).toEqual([])
  })
})

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
      suggested_leverage: 2,
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
      suggested_leverage: 4,
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
      suggested_leverage: 8,
      suggested_position_size_usdc: 1200,
      risk_flags: [],
    },
  ]

  const validAggregationJson = {
    side: "long",
    thesis: "BTC trending up",
    reasoning: "All perspectives aligned",
    confidence_score: 72,
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
    leverage_suggested: 4,
    risk_flags: [],
    consensus_alignment: 80,
    contradictions: [],
    profit_feasible: true,
    entry_price: 64000,
    stop_loss: 61000,
    take_profit: 72000,
    position_size_usdc: 800,
  }

  it("returns sanitized aggregation on valid LLM JSON", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validAggregationJson) } }],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result).not.toBeNull()
    expect(result!.side).toBe("long")
    expect(result!.thesis).toBe("BTC trending up")
    expect(result!.confidence_score).toBe(72)
    expect(result!.consensus_alignment).toBe(80)
    expect(result!.profit_feasible).toBe(true)
    expect(result!.entry_price).toBe(64000)
  })

  it("preserves no_trade outcome with reason", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ ...validAggregationJson, side: "no_trade", no_trade_reason: "Funding overheated" }),
          },
        },
      ],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.side).toBe("no_trade")
    expect(result!.no_trade_reason).toBe("Funding overheated")
  })

  it("clamps bounded numbers to 0-100", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validAggregationJson,
              confidence_score: 150,
              consensus_alignment: -5,
              confidence_breakdown: { factor_alignment: 999, historical_match: -1, signal_strength: 50 },
            }),
          },
        },
      ],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.confidence_score).toBe(100)
    expect(result!.consensus_alignment).toBe(0)
    expect(result!.confidence_breakdown.factor_alignment).toBe(100)
    expect(result!.confidence_breakdown.historical_match).toBe(0)
  })

  it("applies defaults for missing optional fields", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ side: "long", confidence_score: 60 }) } }],
    })

    const result = await aggregate({ reports, ddReport: mockDDReport, targetProfitPercent: 100 })
    expect(result!.thesis).toBe("")
    expect(result!.risk_flags).toEqual([])
    expect(result!.contradictions).toEqual([])
    expect(result!.profit_feasible).toBe(false)
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
