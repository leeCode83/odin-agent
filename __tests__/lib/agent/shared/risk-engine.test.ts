import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  computeATR,
  computeSLTP,
  computePositionSize,
  computeLeverage,
} from "@/lib/agent/shared/risk-engine"
import type { CandleData } from "@/lib/data/types"

// Mock hyperliquid module; hoisted before any imports resolve
const mockFetchOnchainData = vi.hoisted(() => vi.fn())
vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(() => ({})),
  fetchOnchainData: mockFetchOnchainData,
}))

import { computeEntryPrice } from "@/lib/agent/shared/risk-engine"

beforeEach(() => {
  vi.clearAllMocks()
})

// ── computeATR ────────────────────────────────────────────────────────────

describe("computeATR", () => {
  const candles: CandleData[] = [
    { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
    { timestamp: 2, open: 100, high: 110, low: 96, close: 108, volume: 1000 },
    { timestamp: 3, open: 108, high: 112, low: 104, close: 110, volume: 1000 },
    { timestamp: 4, open: 110, high: 116, low: 106, close: 114, volume: 1000 },
    { timestamp: 5, open: 114, high: 118, low: 108, close: 116, volume: 1000 },
  ]

  it("returns correct ATR for known data with period=3", () => {
    // TRs: i=1->14, i=2->8, i=3->10, i=4->10
    // First ATR(3)=(14+8+10)/3=32/3≈10.6667
    // Next: ((32/3*2)+10)/3=94/9≈10.4444
    const atr = computeATR(candles, 3)
    expect(atr).toBeCloseTo(94 / 9, 4)
  })

  it("throws for empty candle array", () => {
    expect(() => computeATR([], 14)).toThrow("Insufficient candles for ATR")
  })

  it("throws when candles length < period + 1", () => {
    expect(() => computeATR(candles, 14)).toThrow("Insufficient candles for ATR")
  })
})

// ── computeSLTP ───────────────────────────────────────────────────────────

describe("computeSLTP", () => {
  it("long: entry=100, ATR=5 -> SL=92.5, TP=115", () => {
    const { stopLoss, takeProfit } = computeSLTP(100, 5, "long")
    expect(stopLoss).toBe(92.5)
    expect(takeProfit).toBe(115)
  })

  it("short: entry=100, ATR=5 -> SL=107.5, TP=85", () => {
    const { stopLoss, takeProfit } = computeSLTP(100, 5, "short")
    expect(stopLoss).toBe(107.5)
    expect(takeProfit).toBe(85)
  })

  it("custom multipliers: slMult=2, tpMult=4", () => {
    const { stopLoss, takeProfit } = computeSLTP(100, 5, "long", {
      slMultiplier: 2,
      tpMultiplier: 4,
    })
    expect(stopLoss).toBe(90)
    expect(takeProfit).toBe(120)
  })

  it("short with custom multipliers", () => {
    const { stopLoss, takeProfit } = computeSLTP(100, 5, "short", {
      slMultiplier: 2,
      tpMultiplier: 4,
    })
    expect(stopLoss).toBe(110)
    expect(takeProfit).toBe(80)
  })
})

// ── computePositionSize ───────────────────────────────────────────────────

describe("computePositionSize", () => {
  it("computes correctly for 1% risk on 10k equity", () => {
    const result = computePositionSize(10000, 100, 95, 1)
    expect(result).toEqual({
      positionSizeContracts: 20,
      positionSizeUsdc: 2000,
    })
  })

  it("returns zeros when entry equals stopLoss (no price risk)", () => {
    const result = computePositionSize(10000, 100, 100, 1)
    expect(result).toEqual({
      positionSizeContracts: 0,
      positionSizeUsdc: 0,
    })
  })
})

// ── computeLeverage ───────────────────────────────────────────────────────

describe("computeLeverage", () => {
  it("confidence 0 -> kappa floor 0.25 applies", () => {
    // atrPct = 0.005, stopPct = 1.5*0.5/100 = 0.0075
    // L_safe = 1/(2*0.0075*1.25) ≈ 53.33, kappa = 0.25
    // L_vol = 0.25*(0.05/0.005) = 2.5 -> min(53.33, 2.5) -> clamp -> 2.5
    expect(computeLeverage({ entry: 100, atr: 0.5, confidence: 0, maxLeverage: 10 })).toBe(2.5)
  })

  it("confidence 1 -> kappa = 1.0", () => {
    // atrPct = 0.01 -> L_vol = 1*(0.05/0.01) = 5
    // L_safe = 1/(2*0.015*1.25) ≈ 26.67 -> min -> 5
    expect(computeLeverage({ entry: 100, atr: 1, confidence: 1, maxLeverage: 10 })).toBe(5)
  })

  it("clamps confidence outside [0,1] to kappa bounds", () => {
    // confidence 2 -> clamp01 -> 1 -> same as confidence 1
    expect(computeLeverage({ entry: 100, atr: 1, confidence: 2, maxLeverage: 10 })).toBe(5)
  })

  it("tiny ATR -> L_vol huge -> clamps to maxLeverage", () => {
    // atrPct = 0.0005, kappa = 0.85 -> L_vol = 0.85*(0.05/0.0005) = 85
    // L_safe = 1/(2*0.00075*1.25) ≈ 533 -> min = 85 -> clamp(1, 20) = 20
    expect(computeLeverage({ entry: 100, atr: 0.05, confidence: 0.8, maxLeverage: 20 })).toBe(20)
  })

  it("large ATR -> L_safe binds (result < L_vol path)", () => {
    // volTarget 0.5: atrPct = 0.03 -> L_vol = 1*(0.5/0.03) ≈ 16.67
    // stopPct = 0.045 -> L_safe = 1/(2*0.045*1.25) ≈ 8.89 -> min -> round -> 8.9
    expect(
      computeLeverage({ entry: 100, atr: 3, confidence: 1, volTarget: 0.5, maxLeverage: 10 })
    ).toBe(8.9)
  })

  it("extreme large ATR -> floor of 1", () => {
    // atrPct = 0.1 -> L_vol = 1*(0.05/0.1) = 0.5 -> clamp(0.5, 1, 10) = 1
    expect(computeLeverage({ entry: 100, atr: 10, confidence: 1, maxLeverage: 10 })).toBe(1)
  })

  it("rounds to 1 decimal (3.333... -> 3.3)", () => {
    // kappa = 0.25 + 0.75*(1/9) = 1/3 -> L_vol = (1/3)*(0.05/0.005) = 3.333...
    // L_safe ≈ 53.33 -> min -> 3.333... -> round -> 3.3
    expect(computeLeverage({ entry: 100, atr: 0.5, confidence: 1 / 9, maxLeverage: 10 })).toBe(3.3)
  })

  it("throws RangeError when entry <= 0", () => {
    expect(() =>
      computeLeverage({ entry: 0, atr: 5, confidence: 0.5, maxLeverage: 10 })
    ).toThrow(RangeError)
    expect(() =>
      computeLeverage({ entry: -1, atr: 5, confidence: 0.5, maxLeverage: 10 })
    ).toThrow(RangeError)
  })

  it("throws RangeError when atr <= 0", () => {
    expect(() =>
      computeLeverage({ entry: 100, atr: 0, confidence: 0.5, maxLeverage: 10 })
    ).toThrow(RangeError)
  })
})

// ── computeEntryPrice ─────────────────────────────────────────────────────

describe("computeEntryPrice", () => {
  it("returns mark price from HL on-chain data", async () => {
    mockFetchOnchainData.mockResolvedValue({ markPrice: 70500 })
    const price = await computeEntryPrice("BTC")
    expect(price).toBe(70500)
  })

  it("returns 0 when HL call fails", async () => {
    mockFetchOnchainData.mockRejectedValue(new Error("API error"))
    const price = await computeEntryPrice("BTC")
    expect(price).toBe(0)
  })
})
