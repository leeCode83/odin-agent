import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/agent/planning/agent", () => ({
  runPlanningAgent: vi.fn(),
}))

import { runPlanningPipeline, PlanningError } from "@/lib/agent/planning/pipeline"
import { runPlanningAgent } from "@/lib/agent/planning/agent"
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
  processingTimeMs: 1500,
}

describe("runPlanningPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls runPlanningAgent and returns validated report with timing", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      report: mockTradePlan,
      timing: { ddMs: 100, planMs: 50, executeMs: 200, aggregateMs: 100, evaluateMs: 50, totalMs: 500 },
      iterations: 1,
      status: "complete",
    })

    const result = await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(runPlanningAgent).toHaveBeenCalledWith({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
      targetProfitPercent: 100,
    })
    expect(result.report).toEqual(mockTradePlan)
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(result.timing.agentMs).toBe(1500)
  })

  it("defaults targetProfitPercent to 100 when omitted", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      report: mockTradePlan,
      timing: { ddMs: 0, planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0, totalMs: 0 },
      iterations: 1,
      status: "complete",
    })

    await runPlanningPipeline({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })

    expect(runPlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({ targetProfitPercent: 100 })
    )
  })

  it("passes through targetProfitPercent when provided", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      report: mockTradePlan,
      timing: { ddMs: 0, planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0, totalMs: 0 },
      iterations: 1,
      status: "complete",
    })

    await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
      targetProfitPercent: 150,
    })

    expect(runPlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({ targetProfitPercent: 150 })
    )
  })

  it("treats a partial status as a successful pipeline result", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      report: mockTradePlan,
      timing: { ddMs: 0, planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0, totalMs: 0 },
      iterations: 3,
      status: "partial",
    })

    const result = await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(result.report).toEqual(mockTradePlan)
  })

  it("throws PlanningError with asset prefix when the agent fails", async () => {
    vi.mocked(runPlanningAgent).mockRejectedValueOnce(new Error("Agent crashed"))

    await expect(
      runPlanningPipeline({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    ).rejects.toThrow(/Planning pipeline failed for BTC: Error: Agent crashed/)
  })

  it("preserves detail and processingTimeMs from an underlying PlanningError", async () => {
    vi.mocked(runPlanningAgent).mockRejectedValueOnce(
      new PlanningError("PLANNING_FAILED", { phase: "dd" }, 321)
    )

    const err = await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PlanningError)
    expect((err as PlanningError).message).toMatch(
      /Planning pipeline failed for BTC: PLANNING_FAILED/
    )
    expect((err as PlanningError).detail).toEqual({ phase: "dd" })
    expect((err as PlanningError).processingTimeMs).toBe(321)
  })

  it("defaults errorCategory to internal", () => {
    const err = new PlanningError("plain failure")

    expect(err.errorCategory).toBe("internal")
  })

  it("preserves errorCategory from an underlying PlanningError", async () => {
    vi.mocked(runPlanningAgent).mockRejectedValueOnce(
      new PlanningError("PLANNING_FAILED", { phase: "dd" }, 321, "data")
    )

    const err = await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PlanningError)
    expect((err as PlanningError).errorCategory).toBe("data")
  })

  it("surfaces the agent status in the pipeline result", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      report: mockTradePlan,
      timing: { ddMs: 0, planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0, totalMs: 0 },
      iterations: 1,
      status: "approval_required",
    })

    const result = await runPlanningPipeline({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(result.status).toBe("approval_required")
  })

  it("wraps TradePlanSchema validation failures in PlanningError", async () => {
    vi.mocked(runPlanningAgent).mockResolvedValueOnce({
      // reason: deliberately schema-invalid report (entry_price undefined) to
      // prove TradePlanSchema.parse runs in the pipeline wrapper.
      report: { ...mockTradePlan, entry_price: undefined } as unknown as TradePlan,
      timing: { ddMs: 0, planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0, totalMs: 0 },
      iterations: 1,
      status: "complete",
    })

    await expect(
      runPlanningPipeline({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    ).rejects.toThrow(/Planning pipeline failed for BTC:/)
  })
})
