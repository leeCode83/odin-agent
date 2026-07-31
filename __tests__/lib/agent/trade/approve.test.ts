import { describe, it, expect, vi, beforeEach } from "vitest"
import { approveTradePlan } from "@/lib/agent/trade/approve"
import type { TradePlan } from "@/lib/agent/types"

const mockTradePlan: TradePlan = {
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

const mockExecutionOutput = {
  execution: {
    status: "placed",
    orders: [{ type: "entry", oid: 100, status: "open" }],
    groupId: "normalTpsl",
    fillStatus: "pending",
    fillAmount: null,
    fillPrice: null,
    timestamp: "2026-07-20T10:00:05Z",
    decisionKey: "abc123",
  },
  timing: { buildMs: 1, placeMs: 200, graphMs: 50, totalMs: 251 },
}

const { mockRunExecutionPipeline } = vi.hoisted(() => ({
  mockRunExecutionPipeline: vi.fn(),
}))

vi.mock("@/lib/agent/execution/pipeline", () => ({
  runExecutionPipeline: mockRunExecutionPipeline,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRunExecutionPipeline.mockResolvedValue(mockExecutionOutput)
})

describe("approveTradePlan", () => {
  it("calls execution pipeline with trade plan and optional ddReport", async () => {
    const output = await approveTradePlan({
      tradePlan: mockTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(output).toEqual(mockExecutionOutput)
    expect(mockRunExecutionPipeline).toHaveBeenCalledWith({
      tradePlan: mockTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
      ddReport: undefined,
    })
  })

  it("passes ddReport when provided", async () => {
    const ddReport = { asset: "BTC", category: "major", timestamp: "2026-01-01T00:00:00Z", sections: {} as never, aggregated_thesis: "", confidence_score: 0, risk_flags: [] }
    await approveTradePlan({
      tradePlan: mockTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
      ddReport,
    })

    expect(mockRunExecutionPipeline).toHaveBeenCalledWith({
      tradePlan: mockTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
      ddReport,
    })
  })

  it("propagates execution errors", async () => {
    mockRunExecutionPipeline.mockRejectedValue(new Error("not initialized"))
    await expect(
      approveTradePlan({
        tradePlan: mockTradePlan,
        walletAddress: "0xmaster",
        userId: "user-1",
      })
    ).rejects.toThrow("not initialized")
  })
})
