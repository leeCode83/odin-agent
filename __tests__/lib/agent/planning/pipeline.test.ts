import { describe, it, expect, vi, beforeEach } from "vitest"
import { runPlanningPipeline } from "@/lib/agent/planning/pipeline"
import type { DDReport } from "@/lib/agent/types"
import type { PerspectiveResult } from "@/lib/agent/planning/types"

const {
  mockFetchMarkPrice,
  mockFetchUserEquity,
  mockFetchCandlesForATR,
  mockQueryGraphPatterns,
  mockGetRiskThresholds,
  mockGeneratePerspective,
  mockAggregatePerspectives,
  mockComputePositionSize,
} = vi.hoisted(() => ({
  mockFetchMarkPrice: vi.fn(),
  mockFetchUserEquity: vi.fn(),
  mockFetchCandlesForATR: vi.fn(),
  mockQueryGraphPatterns: vi.fn(),
  mockGetRiskThresholds: vi.fn(),
  mockGeneratePerspective: vi.fn(),
  mockAggregatePerspectives: vi.fn(),
  mockComputePositionSize: vi.fn(() => ({ positionSizeUsdc: 100, positionSizeContracts: 1 })),
}))

vi.mock("@/lib/data/hyperliquid", () => ({
  fetchMarkPrice: mockFetchMarkPrice,
  fetchUserEquity: mockFetchUserEquity,
  fetchCandlesForATR: mockFetchCandlesForATR,
}))
vi.mock("@/lib/db/graph-memory", () => ({
  queryGraphPatterns: mockQueryGraphPatterns,
}))
vi.mock("@/lib/db/risk-thresholds", () => ({
  getRiskThresholds: mockGetRiskThresholds,
}))
vi.mock("@/lib/agent/planning/llm", () => ({
  generatePerspective: mockGeneratePerspective,
  aggregatePerspectives: mockAggregatePerspectives,
}))
vi.mock("@/lib/agent/planning/risk-engine", () => ({
  computeATR: vi.fn(() => 5),
  computeSLTP: vi.fn(() => ({ stopLoss: 95, takeProfit: 115 })),
  computePositionSize: mockComputePositionSize,
  capLeverage: vi.fn(() => 5),
}))

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "major",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish", signals: ["RSI > 60"] },
    onchain: { score: 60, summary: "Neutral", signals: [] },
    sentiment: { score: 55, summary: "Neutral", signals: [] },
    fundamental: { score: 80, summary: "Strong", signals: [] },
  },
  aggregated_thesis: "BTC has upside",
  confidence_score: 65,
  risk_flags: [],
  errors: [],
}

const mockPerspective: PerspectiveResult = {
  perspective: "balance",
  thesis: "BTC bullish",
  confidence_breakdown: { factor_alignment: 75, historical_match: 60, signal_strength: 80 },
  side: "long",
  leverage_suggested: 5,
  reasoning: "Technical strength",
  reasoningContent: "Analyzing...",
  risk_flags: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchUserEquity.mockResolvedValue(10000)
  mockFetchCandlesForATR.mockResolvedValue([
    { timestamp: 1, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    { timestamp: 2, open: 105, high: 115, low: 100, close: 110, volume: 1200 },
    { timestamp: 3, open: 110, high: 120, low: 105, close: 115, volume: 1100 },
    { timestamp: 4, open: 115, high: 125, low: 110, close: 120, volume: 1300 },
    { timestamp: 5, open: 120, high: 130, low: 115, close: 125, volume: 1400 },
    { timestamp: 6, open: 125, high: 135, low: 120, close: 130, volume: 1500 },
    { timestamp: 7, open: 130, high: 140, low: 125, close: 135, volume: 1600 },
    { timestamp: 8, open: 135, high: 145, low: 130, close: 140, volume: 1700 },
    { timestamp: 9, open: 140, high: 150, low: 135, close: 145, volume: 1800 },
    { timestamp: 10, open: 145, high: 155, low: 140, close: 150, volume: 1900 },
    { timestamp: 11, open: 150, high: 160, low: 145, close: 155, volume: 2000 },
    { timestamp: 12, open: 155, high: 165, low: 150, close: 160, volume: 2100 },
    { timestamp: 13, open: 160, high: 170, low: 155, close: 165, volume: 2200 },
    { timestamp: 14, open: 165, high: 175, low: 160, close: 170, volume: 2300 },
    { timestamp: 15, open: 170, high: 180, low: 165, close: 175, volume: 2400 },
  ])
  mockQueryGraphPatterns.mockResolvedValue([{ pattern: "uptrend", outcome: "bullish", frequency: 3 }])
  mockFetchMarkPrice.mockResolvedValue(100)
  mockGetRiskThresholds.mockResolvedValue({
    confidence_threshold: 70,
    max_position_usdc: 100,
    max_leverage: 10,
    risk_per_trade_percent: 1,
  })
  mockGeneratePerspective.mockResolvedValue(mockPerspective)
  mockAggregatePerspectives.mockResolvedValue({
    side: "long",
    thesis: "Aggregated thesis BTC",
    reasoning: "Consensus bullish",
    confidence_score: 75,
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
    leverage_suggested: 5,
    risk_flags: [],
  })
})

describe("runPlanningPipeline", () => {
  it("returns PlanningPipelineOutput with TradePlan and timing", async () => {
    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(output.plan).toBeDefined()
    expect(output.plan.asset).toBe("BTC")
    expect(output.plan.side).toBe("long")
    expect(output.plan.entry_price).toBe(100)
    expect(output.plan.confidence_score).toBeGreaterThanOrEqual(0)
    expect(output.plan.autonomy_decision).toBe("auto")
    expect(output.plan.graph_patterns_used).toHaveLength(1)
    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.fetchMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.graphMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.llmMs).toBeGreaterThanOrEqual(0)
  })

  it("auto-executes when confidence >= threshold and size <= max", async () => {
    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })
    expect(output.plan.autonomy_decision).toBe("auto")
  })

  it("requires approval when confidence below threshold", async () => {
    mockGetRiskThresholds.mockResolvedValue({
      confidence_threshold: 95,
      max_position_usdc: 100,
      max_leverage: 10,
      risk_per_trade_percent: 1,
    })
    mockAggregatePerspectives.mockResolvedValue({
      side: "long",
      thesis: "weak",
      reasoning: "weak",
      confidence_score: 30,
      confidence_breakdown: { factor_alignment: 30, historical_match: 30, signal_strength: 30 },
      leverage_suggested: 1,
      risk_flags: [],
    })

    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })
    expect(output.plan.autonomy_decision).toBe("approve")
  })

  it("requires approval when size exceeds max", async () => {
    mockComputePositionSize.mockReturnValue({
      positionSizeUsdc: 500,
      positionSizeContracts: 5,
    })

    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })
    expect(output.plan.autonomy_decision).toBe("approve")
  })

  it("throws PlanningError when all LLM perspectives fail", async () => {
    mockGeneratePerspective.mockResolvedValue(null)
    await expect(
      runPlanningPipeline({
        ddReport: mockDDReport,
        userId: "user-1",
        walletAddress: "0x123",
      })
    ).rejects.toThrow("All 3 LLM perspectives failed")
  })

  it("recovers from non-fatal graph fetch failure", async () => {
    mockQueryGraphPatterns.mockRejectedValue(new Error("DB down"))

    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(output.plan).toBeDefined()
    expect(output.plan.graph_patterns_used).toEqual([])
  })

  it("throws when aggregator fails", async () => {
    mockAggregatePerspectives.mockResolvedValue(null)

    await expect(
      runPlanningPipeline({
        ddReport: mockDDReport,
        userId: "user-1",
        walletAddress: "0x123",
      })
    ).rejects.toThrow("Aggregator LLM call failed")
  })

  it("handles empty graph patterns gracefully", async () => {
    mockQueryGraphPatterns.mockResolvedValue([])

    const output = await runPlanningPipeline({
      ddReport: mockDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(output.plan.graph_patterns_used).toEqual([])
  })
})
