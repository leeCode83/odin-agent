import { describe, it, expect, vi, afterEach } from "vitest"
import {
  getBinanceFundingTool,
  getBinanceOITool,
  getBinanceVolumeTool,
} from "@/lib/data/onchain/binance"

const mockPremiumIndex = {
  symbol: "BTCUSDT",
  markPrice: "70500.00",
  indexPrice: "70490.00",
  estimatedSettlePrice: "70500.00",
  lastFundingRate: "0.0001",
  nextFundingTime: 1710000000000,
  time: 1710000000000,
}

const mockOpenInterest = {
  symbol: "BTCUSDT",
  openInterest: "125000.5",
  time: 1710000000000,
}

const mockTicker24h = {
  symbol: "BTCUSDT",
  lastPrice: "70500.00",
  quoteVolume: "5000000000.00",
  priceChangePercent: "2.5",
}

describe("getBinanceFundingTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns funding data on successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockPremiumIndex),
    }))
    const result = await getBinanceFundingTool("BTC")
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      fundingRate: 0.0001,
      markPrice: 70500,
      oraclePrice: 70490,
    })
    expect(result.metadata.source).toBe("binance")
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("handles ETH asset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ...mockPremiumIndex,
        symbol: "ETHUSDT",
        markPrice: "3500.00",
        indexPrice: "3498.50",
        lastFundingRate: "0.00005",
      }),
    }))
    const result = await getBinanceFundingTool("ETH")
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("fundingRate", 0.00005)
    expect(result.data).toHaveProperty("markPrice", 3500)
  })
})

describe("getBinanceOITool", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns open interest on successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockOpenInterest),
    }))
    const result = await getBinanceOITool("BTC")
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ openInterest: 125000.5 })
    expect(result.metadata.source).toBe("binance")
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("returns error when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
    const result = await getBinanceOITool("BTC")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to fetch Binance OI")
  })
})

describe("getBinanceVolumeTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns 24h volume on successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockTicker24h),
    }))
    const result = await getBinanceVolumeTool("BTC")
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ volume24h: 5000000000 })
    expect(result.metadata.source).toBe("binance")
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("returns error when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
    const result = await getBinanceVolumeTool("BTC")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to fetch Binance volume")
  })
})
