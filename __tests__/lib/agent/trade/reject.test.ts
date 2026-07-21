import { describe, it, expect, vi, beforeEach } from "vitest"
import { rejectTradePlan } from "@/lib/agent/trade/reject"
import type { TradePlan } from "@/lib/agent/types"

const mockTradePlan: TradePlan = {
  asset: "BTC",
  side: "long",
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
  autonomy_decision: "approve",
  risk_flags: [],
  graph_patterns_used: [],
  timestamp: "2026-07-20T10:00:00Z",
}

const { mockRecordGraphMemory, mockRecordOutcome } = vi.hoisted(() => ({
  mockRecordGraphMemory: vi.fn(),
  mockRecordOutcome: vi.fn(),
}))

vi.mock("@/lib/db/graph-memory", () => ({
  recordGraphMemory: mockRecordGraphMemory,
  recordOutcome: mockRecordOutcome,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockRecordGraphMemory.mockResolvedValue("decision-1")
  mockRecordOutcome.mockResolvedValue("outcome-1")
})

describe("rejectTradePlan", () => {
  it("records decision and outcome nodes", async () => {
    const result = await rejectTradePlan({
      tradePlan: mockTradePlan,
      userId: "user-1",
    })

    expect(result.decisionKey).toBe("decision-1")
    expect(mockRecordGraphMemory).toHaveBeenCalledWith({
      userId: "user-1",
      asset: "BTC",
      tradePlan: mockTradePlan,
      signals: [],
    })
    expect(mockRecordOutcome).toHaveBeenCalledWith("decision-1", {
      result: "cancelled",
      exitReason: "manual_reject",
    })
  })

  it("uses custom reason when provided", async () => {
    await rejectTradePlan({
      tradePlan: mockTradePlan,
      userId: "user-1",
      reason: "low_confidence",
    })

    expect(mockRecordOutcome).toHaveBeenCalledWith("decision-1", {
      result: "cancelled",
      exitReason: "low_confidence",
    })
  })

  it("propagates DB errors", async () => {
    mockRecordGraphMemory.mockRejectedValue(new Error("ArangoDB not available"))
    await expect(
      rejectTradePlan({
        tradePlan: mockTradePlan,
        userId: "user-1",
      })
    ).rejects.toThrow("ArangoDB not available")
  })
})
