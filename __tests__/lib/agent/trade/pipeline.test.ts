import { describe, it, expect, vi, beforeEach } from "vitest"
import { runTradePipeline } from "@/lib/agent/trade/pipeline"
import type { DDReport, TradePlan } from "@/lib/agent/types"

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "major",
  timestamp: "2026-07-20T10:00:00Z",
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

const mockTradePlanAuto: TradePlan = {
  asset: "BTC",
  side: "long",
  action: "LONG",
  entry_price: 65000,
  position_size_usdc: 50,
  position_size_contracts: 0.001,
  stop_loss: 64000,
  take_profit: 68000,
  leverage: 3,
  confidence_score: 75,
  confidence_breakdown: { factor_alignment: 75, historical_match: 60, signal_strength: 80 },
  thesis: "BTC bullish",
  reasoning: "Technical strength",
  autonomy_decision: "auto",
  risk_flags: [],
  graph_patterns_used: [],
  timestamp: "2026-07-20T10:00:00Z",
}

const mockTradePlanApprove: TradePlan = {
  ...mockTradePlanAuto,
  autonomy_decision: "approve",
}

const mockExecutionOutput = {
  execution: {
    status: "placed",
    orders: [
      { type: "entry", oid: 100, status: "open" },
      { type: "take_profit", oid: 101, status: "open" },
      { type: "stop_loss", oid: 102, status: "open" },
    ],
    groupId: "normalTpsl",
    fillStatus: "pending",
    fillAmount: null,
    fillPrice: null,
    timestamp: "2026-07-20T10:00:05Z",
    decisionKey: "abc123",
  },
  timing: { buildMs: 1, placeMs: 200, graphMs: 50, totalMs: 251 },
}

const { mockRunDDPipeline, mockRunPlanningPipeline, mockRunExecutionPipeline } = vi.hoisted(() => ({
  mockRunDDPipeline: vi.fn(),
  mockRunPlanningPipeline: vi.fn(),
  mockRunExecutionPipeline: vi.fn(),
}))

vi.mock("@/lib/agent/due-diligence/pipeline", () => ({
  runDDPipeline: mockRunDDPipeline,
}))
vi.mock("@/lib/agent/planning/pipeline", () => ({
  runPlanningPipeline: mockRunPlanningPipeline,
}))
vi.mock("@/lib/agent/execution/pipeline", () => ({
  runExecutionPipeline: mockRunExecutionPipeline,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRunDDPipeline.mockResolvedValue({ report: mockDDReport, timing: { fetchMs: 100, llmMs: 200, totalMs: 300 } })
  mockRunPlanningPipeline.mockResolvedValue({ report: mockTradePlanAuto, timing: { totalMs: 380, agentMs: 300 } })
  mockRunExecutionPipeline.mockResolvedValue(mockExecutionOutput)
})

describe("runTradePipeline", () => {
  it("returns executed status when autonomy is auto", async () => {
    const output = await runTradePipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
    })

    expect(output.status).toBe("executed")
    expect(output.ddReport).toEqual(mockDDReport)
    expect(output.tradePlan).toEqual(mockTradePlanAuto)
    expect(output.execution).toBeDefined()
    expect(output.execution?.status).toBe("placed")
    expect(typeof output.timing.totalMs).toBe("number")
  })

  it("returns requires_approval when autonomy is approve", async () => {
    mockRunPlanningPipeline.mockResolvedValue({ report: mockTradePlanApprove, timing: { totalMs: 380, agentMs: 300 } })

    const output = await runTradePipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
    })

    expect(output.status).toBe("requires_approval")
    expect(output.tradePlan).toEqual(mockTradePlanApprove)
    expect(output.execution).toBeUndefined()
  })

  it("chains DD → Planning → Execution in order", async () => {
    await runTradePipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
    })

    expect(mockRunDDPipeline).toHaveBeenCalledWith({ asset: "BTC", userId: "user-1" })
    expect(mockRunPlanningPipeline).toHaveBeenCalledWith({ asset: "BTC", userId: "user-1", walletAddress: "0xmaster" })
    expect(mockRunExecutionPipeline).toHaveBeenCalledWith({ tradePlan: mockTradePlanAuto, walletAddress: "0xmaster", userId: "user-1", ddReport: mockDDReport })
  })

  it("does not call execution when plan requires approval", async () => {
    mockRunPlanningPipeline.mockResolvedValue({ report: mockTradePlanApprove, timing: { totalMs: 380, agentMs: 300 } })

    await runTradePipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
    })

    expect(mockRunDDPipeline).toHaveBeenCalledOnce()
    expect(mockRunPlanningPipeline).toHaveBeenCalledOnce()
    expect(mockRunExecutionPipeline).not.toHaveBeenCalled()
  })

  it("propagates DD pipeline errors", async () => {
    mockRunDDPipeline.mockRejectedValue(new Error("DD failed"))
    await expect(
      runTradePipeline({
        asset: "BTC",
        userId: "user-1",
        walletAddress: "0xmaster",
      })
    ).rejects.toThrow("DD failed")
  })

  it("propagates planning pipeline errors", async () => {
    mockRunPlanningPipeline.mockRejectedValue(new Error("Planning failed"))
    await expect(
      runTradePipeline({
        asset: "BTC",
        userId: "user-1",
        walletAddress: "0xmaster",
      })
    ).rejects.toThrow("Planning failed")
  })

  it("propagates execution pipeline errors", async () => {
    mockRunExecutionPipeline.mockRejectedValue(new Error("Execution failed"))
    await expect(
      runTradePipeline({
        asset: "BTC",
        userId: "user-1",
        walletAddress: "0xmaster",
      })
    ).rejects.toThrow("Execution failed")
  })
})
