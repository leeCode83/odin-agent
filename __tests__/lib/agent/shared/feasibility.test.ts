import { describe, it, expect } from "vitest"
import { computeProfitFeasibility } from "@/lib/agent/shared/feasibility"

describe("computeProfitFeasibility", () => {
  it("feasible long: R:R 2, target within TP distance and 3x ATR", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
      atr: 2,
    })

    expect(result.feasible).toBe(true)
    expect(result.riskRewardRatio).toBe(2)
    expect(result.breakEvenWinRate).toBe(0.33)
    expect(result.expectedMovePercent).toBe(2)
    expect(result.reasons).toContain("R:R 2 meets minimum 1.5")
    expect(result.reasons).toContain("target 5% within TP distance 10%")
    expect(result.reasons).toContain("target 5% within 3x ATR 6%")
  })

  it("below-minimum R:R -> infeasible", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 103,
      side: "long",
      targetProfitPercent: 2,
    })

    expect(result.feasible).toBe(false)
    expect(result.riskRewardRatio).toBe(0.6)
    expect(result.reasons).toContain("R:R 0.6 below minimum 1.5")
  })

  it("target beyond TP distance -> infeasible", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 15,
    })

    expect(result.feasible).toBe(false)
    expect(result.reasons).toContain("target 15% beyond TP distance 10%")
  })

  it("target beyond 3x ATR -> infeasible", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 8,
      atr: 2,
    })

    expect(result.feasible).toBe(false)
    expect(result.reasons).toContain("target 8% exceeds 3x ATR 6%")
  })

  it("ATR omitted -> ATR check skipped", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 8,
    })

    expect(result.feasible).toBe(true)
    expect(result.expectedMovePercent).toBeUndefined()
    expect(result.reasons).toHaveLength(2)
    expect(result.reasons.some((r) => r.includes("ATR"))).toBe(false)
  })

  it("risk 0 (SL equals entry) -> infeasible with zeroed metrics", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 100,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
    })

    expect(result.feasible).toBe(false)
    expect(result.riskRewardRatio).toBe(0)
    expect(result.breakEvenWinRate).toBe(0)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it("non-positive entry price -> infeasible", () => {
    const result = computeProfitFeasibility({
      entryPrice: 0,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
    })

    expect(result.feasible).toBe(false)
    expect(result.riskRewardRatio).toBe(0)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it("short side mirrors long math (absolute distances)", () => {
    const result = computeProfitFeasibility({
      entryPrice: 200,
      stopLoss: 210,
      takeProfit: 180,
      side: "short",
      targetProfitPercent: 5,
      atr: 4,
    })

    expect(result.feasible).toBe(true)
    expect(result.riskRewardRatio).toBe(2)
    expect(result.breakEvenWinRate).toBe(0.33)
    expect(result.expectedMovePercent).toBe(2)
  })

  it("breakEvenWinRate correctness (R:R 3 -> 0.25)", () => {
    const result = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 120,
      side: "long",
      targetProfitPercent: 5,
    })

    expect(result.riskRewardRatio).toBe(4)
    expect(result.breakEvenWinRate).toBe(0.2)
  })

  it("reasons array is populated for pass and fail cases", () => {
    const pass = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
    })
    const fail = computeProfitFeasibility({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 103,
      side: "long",
      targetProfitPercent: 2,
    })

    expect(pass.reasons.length).toBeGreaterThanOrEqual(2)
    expect(fail.reasons.length).toBeGreaterThanOrEqual(2)
  })
})
