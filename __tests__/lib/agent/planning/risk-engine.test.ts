import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  computeATR,
  computeSLTP,
  computePositionSize,
  capLeverage,
} from "@/lib/agent/planning/risk-engine"
import type { CandleData } from "@/lib/data/types"

// Mock hyperliquid module; hoisted before any imports resolve
const mockFetchOnchainData = vi.hoisted(() => vi.fn())
vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(() => ({})),
  fetchOnchainData: mockFetchOnchainData,
}))

import { computeEntryPrice } from "@/lib/agent/planning/risk-engine"

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

// ── capLeverage ───────────────────────────────────────────────────────────

describe("capLeverage", () => {
  it("caps when llm suggested exceeds max allowed", () => {
    expect(capLeverage(15, 10)).toBe(10)
  })

  it("returns llm value when within max allowed", () => {
    expect(capLeverage(5, 10)).toBe(5)
  })

  it("rounds to 1 decimal place", () => {
    expect(capLeverage(3.3333, 10)).toBe(3.3)
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
