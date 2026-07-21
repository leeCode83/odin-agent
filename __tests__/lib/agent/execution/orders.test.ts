import { describe, it, expect } from "vitest"
import { buildOrders } from "@/lib/agent/execution/orders"
import type { TradePlan } from "@/lib/agent/types"

const ASSET_INDEX = 0

const longPlan: TradePlan = {
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
  autonomy_decision: "auto",
  risk_flags: [],
  graph_patterns_used: [],
  timestamp: "2026-07-20T10:00:00Z",
}

const shortPlan: TradePlan = {
  ...longPlan,
  side: "short",
  entry_price: 65000,
  stop_loss: 66000,
  take_profit: 62000,
}

describe("buildOrders", () => {
  it("builds entry order with limit Gtc for long", () => {
    const { entry } = buildOrders(longPlan, ASSET_INDEX, 5)
    expect(entry.a).toBe(0)
    expect(entry.b).toBe(true)
    expect(entry.p).toBe("65000")
    expect(entry.s).toBe("0.001")
    expect(entry.r).toBe(false)
    expect(entry.t).toEqual({ limit: { tif: "Gtc" } })
  })

  it("builds entry order with limit Gtc for short", () => {
    const { entry } = buildOrders(shortPlan, ASSET_INDEX, 5)
    expect(entry.b).toBe(false)
    expect(entry.t).toEqual({ limit: { tif: "Gtc" } })
  })

  it("builds take profit with reduceOnly true and correct tpsl for long", () => {
    const { takeProfit } = buildOrders(longPlan, ASSET_INDEX, 5)
    expect(takeProfit.a).toBe(0)
    expect(takeProfit.b).toBe(false)
    expect(takeProfit.p).toBe("68000")
    expect(takeProfit.r).toBe(true)
    expect(takeProfit.t).toEqual({
      trigger: { isMarket: false, triggerPx: "68000", tpsl: "tp" },
    })
  })

  it("builds take profit for short", () => {
    const { takeProfit } = buildOrders(shortPlan, ASSET_INDEX, 5)
    expect(takeProfit.b).toBe(true)
    expect(takeProfit.p).toBe("62000")
    expect(takeProfit.t).toEqual({
      trigger: { isMarket: false, triggerPx: "62000", tpsl: "tp" },
    })
  })

  it("builds stop loss for long", () => {
    const { stopLoss } = buildOrders(longPlan, ASSET_INDEX, 5)
    expect(stopLoss.p).toBe("64000")
    expect(stopLoss.r).toBe(true)
    expect(stopLoss.t).toEqual({
      trigger: { isMarket: false, triggerPx: "64000", tpsl: "sl" },
    })
  })

  it("builds stop loss for short", () => {
    const { stopLoss } = buildOrders(shortPlan, ASSET_INDEX, 5)
    expect(stopLoss.p).toBe("66000")
    expect(stopLoss.t).toEqual({
      trigger: { isMarket: false, triggerPx: "66000", tpsl: "sl" },
    })
  })

  it("opposite sides for entry vs close orders for long", () => {
    const { entry, takeProfit, stopLoss } = buildOrders(longPlan, ASSET_INDEX, 5)
    expect(entry.b).toBe(true)
    expect(takeProfit.b).toBe(false)
    expect(stopLoss.b).toBe(false)
  })

  it("reverses sides correctly for short", () => {
    const { entry, takeProfit, stopLoss } = buildOrders(shortPlan, ASSET_INDEX, 5)
    expect(entry.b).toBe(false)
    expect(takeProfit.b).toBe(true)
    expect(stopLoss.b).toBe(true)
  })
})
