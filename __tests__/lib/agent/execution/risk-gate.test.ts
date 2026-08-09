import { describe, it, expect } from "vitest"
import { verifyTradePlanAgainstRisk } from "@/lib/agent/execution/risk-gate"
import type { TradePlan, RiskThresholds } from "@/lib/agent/types"

const thresholds: RiskThresholds = {
  confidence_threshold: 30,
  max_position_usdc: 3000,
  max_leverage: 10,
  risk_per_trade_percent: 10,
}

function makePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    asset: "BTC",
    side: "long",
    action: "LONG",
    entry_price: 100,
    position_size_usdc: 100,
    position_size_contracts: 1,
    stop_loss: 95,
    take_profit: 110,
    leverage: 3,
    confidence_score: 70,
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
    thesis: "t",
    reasoning: "r",
    autonomy_decision: "auto",
    risk_flags: [],
    graph_patterns_used: [],
    timestamp: "2026-07-20T10:00:00Z",
    ...overrides,
  }
}

describe("verifyTradePlanAgainstRisk", () => {
  it("passes when all checks pass", () => {
    const result = verifyTradePlanAgainstRisk(makePlan(), { thresholds, accountState: { equityUsdc: 1000 } })
    expect(result).toEqual({ ok: true })
  })

  it("rejects when leverage exceeds thresholds.max_leverage", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 20, stop_loss: 99.5 }),
      { thresholds }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("leverage=20 exceeds cap 10")
    }
  })

  it("rejects when leverage is non-positive", () => {
    const result = verifyTradePlanAgainstRisk(makePlan({ leverage: 0 }), { thresholds })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("must be positive")
    }
  })

  it("rejects when per-asset maxLeverage cap is stricter than thresholds", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 7, stop_loss: 98 }),
      { thresholds, accountState: { assetMaxLeverage: 5 } }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("leverage=7 exceeds cap 5")
    }
  })

  it("rejects long SL outside the liquidation cushion (L=10, SL 4.5% away vs 4% headroom line)", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 10, stop_loss: 95.5 }),
      { thresholds }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("liquidation-cushion headroom line 96")
    }
  })

  it("accepts long SL just inside the cushion headroom line", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 10, stop_loss: 96.5 }),
      { thresholds, accountState: { equityUsdc: 1000 } }
    )
    expect(result).toEqual({ ok: true })
  })

  it("rejects short SL outside the liquidation cushion", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ side: "short", leverage: 10, stop_loss: 104.5 }),
      { thresholds }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("liquidation-cushion headroom line 104")
    }
  })

  it("accepts short SL just inside the cushion headroom line", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ side: "short", leverage: 10, stop_loss: 103.5 }),
      { thresholds, accountState: { equityUsdc: 1000 } }
    )
    expect(result).toEqual({ ok: true })
  })

  it("rejects position size above allowed risk budget × 1.05", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ entry_price: 100, stop_loss: 90, position_size_usdc: 1100 }),
      { thresholds, accountState: { equityUsdc: 1000 } }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(" ")).toContain("position_size_usdc=1100 exceeds risk-budget size 1000")
    }
  })

  it("accepts position size within the 5% rounding tolerance", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ entry_price: 100, stop_loss: 90, position_size_usdc: 1049 }),
      { thresholds, accountState: { equityUsdc: 1000 } }
    )
    expect(result).toEqual({ ok: true })
  })

  it("skips the size check when equity is missing", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ entry_price: 100, stop_loss: 90, position_size_usdc: 999999 }),
      { thresholds }
    )
    expect(result).toEqual({ ok: true })
  })

  it("passes trivially for NO_TRADE action", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ action: "NO_TRADE", leverage: 20, stop_loss: 1, position_size_usdc: 999999 }),
      { thresholds }
    )
    expect(result).toEqual({ ok: true })
  })

  it("passes trivially for the leverage-1 / zero-size sentinel", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 1, position_size_usdc: 0, stop_loss: 1 }),
      { thresholds }
    )
    expect(result).toEqual({ ok: true })
  })

  it("reports all violations at once", () => {
    const result = verifyTradePlanAgainstRisk(
      makePlan({ leverage: 20, stop_loss: 95.5, position_size_usdc: 3000 }),
      { thresholds, accountState: { equityUsdc: 1000 } }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons).toHaveLength(3)
      expect(result.reasons.join(" ")).toContain("leverage=20 exceeds cap 10")
      expect(result.reasons.join(" ")).toContain("liquidation-cushion headroom line")
      expect(result.reasons.join(" ")).toContain("exceeds risk-budget size")
    }
  })
})
