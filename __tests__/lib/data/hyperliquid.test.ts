import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHLClient, fetchCandles, fetchOnchainData, fetchAllHLData, fetchMarkPrice, fetchUserEquity, fetchCandlesForATR } from "@/lib/data/hyperliquid"

const { mockCandleSnapshot, mockMetaAndAssetCtxs, mockFundingHistory, mockPerpsAtOpenInterestCap, mockAllMids, mockUserClearingState } = vi.hoisted(() => ({
  mockCandleSnapshot: vi.fn().mockResolvedValue([
    { t: 1710000000000, T: 1710003600000, s: "BTC", i: "1h", o: "70000", c: "70500", h: "71000", l: "69000", v: "1000", n: 500 },
  ]),
  mockMetaAndAssetCtxs: vi.fn().mockResolvedValue([
    {
      universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 1 }],
      marginTables: [],
      collateralToken: 0,
    },
    [
      {
        prevDayPx: "70000",
        dayNtlVlm: "2000000000",
        markPx: "70500",
        midPx: "70450",
        funding: "0.0001",
        openInterest: "1500000000",
        premium: "0.00005",
        oraclePx: "70400",
        impactPxs: null,
        dayBaseVlm: "28571",
      },
    ],
  ]),
  mockFundingHistory: vi.fn().mockResolvedValue([
    { coin: "BTC", fundingRate: "0.0001", premium: "0.00005", time: 1710000000000 },
  ]),
  mockPerpsAtOpenInterestCap: vi.fn().mockResolvedValue([]),
  mockAllMids: vi.fn().mockResolvedValue({ "BTC": "70500", "ETH": "3500" }),
  mockUserClearingState: vi.fn().mockResolvedValue({ crossMarginSummary: { accountValue: "10000" } }),
}))

vi.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: vi.fn().mockImplementation(function () { return {} }),
  InfoClient: vi.fn().mockImplementation(function () {
    return {
      candleSnapshot: mockCandleSnapshot,
      metaAndAssetCtxs: mockMetaAndAssetCtxs,
      fundingHistory: mockFundingHistory,
      perpsAtOpenInterestCap: mockPerpsAtOpenInterestCap,
      allMids: mockAllMids,
      userClearingState: mockUserClearingState,
    }
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createHLClient", () => {
  it("returns a client object", () => {
    const client = createHLClient()
    expect(client).toBeDefined()
    expect(typeof client.candleSnapshot).toBe("function")
  })
})

describe("fetchCandles", () => {
  it("returns candle data array", async () => {
    const client = createHLClient()
    const candles = await fetchCandles(client, "BTC")
    expect(Array.isArray(candles)).toBe(true)
    if (candles.length > 0) {
      expect(candles[0]).toHaveProperty("timestamp")
      expect(candles[0]).toHaveProperty("open")
      expect(candles[0]).toHaveProperty("close")
    }
  })

  it("returns candles with correct shape", async () => {
    const client = createHLClient()
    const candles = await fetchCandles(client, "BTC")
    expect(candles.length).toBeGreaterThan(0)
    expect(typeof candles[0].timestamp).toBe("number")
    expect(typeof candles[0].open).toBe("number")
    expect(typeof candles[0].high).toBe("number")
    expect(typeof candles[0].low).toBe("number")
    expect(typeof candles[0].close).toBe("number")
    expect(typeof candles[0].volume).toBe("number")
  })
})

describe("fetchOnchainData", () => {
  it("returns onchain data object", async () => {
    const client = createHLClient()
    const data = await fetchOnchainData(client, "BTC")
    expect(data).toHaveProperty("fundingRate")
    expect(data).toHaveProperty("openInterest")
    expect(data).toHaveProperty("markPrice")
    expect(data).toHaveProperty("oiCapReached")
    expect(typeof data.fundingRate).toBe("number")
    expect(typeof data.markPrice).toBe("number")
    expect(data.oiCapReached).toBe(false)
  })
})

describe("fetchAllHLData", () => {
  it("returns combined technical + onchain data", async () => {
    const data = await fetchAllHLData("BTC")
    expect(data).toHaveProperty("candles1h")
    expect(data).toHaveProperty("onchain")
    expect(data.onchain).toHaveProperty("fundingRate")
  })

  it("handles errors gracefully after exhausting retries", async () => {
    mockCandleSnapshot.mockRejectedValue(new Error("API down"))
    await expect(fetchAllHLData("BTC")).rejects.toThrow()
  }, 10_000)
})

describe("fetchMarkPrice", () => {
  it("returns mid price > 0 for known asset", async () => {
    const price = await fetchMarkPrice("BTC")
    expect(typeof price).toBe("number")
    expect(price).toBeGreaterThan(0)
  })

  it("throws for unknown asset", async () => {
    mockAllMids.mockResolvedValueOnce({ "BTC": "70500" })
    await expect(fetchMarkPrice("DOGE")).rejects.toThrow()
  })
})

describe("fetchUserEquity", () => {
  it("returns account value >= 0", async () => {
    const equity = await fetchUserEquity("0x123")
    expect(typeof equity).toBe("number")
    expect(equity).toBeGreaterThanOrEqual(0)
  })

  it("returns 0 for non-existent user", async () => {
    mockUserClearingState.mockResolvedValueOnce(null)
    const equity = await fetchUserEquity("")
    expect(equity).toBe(0)
  })
})

describe("fetchCandlesForATR", () => {
  beforeEach(() => {
    mockCandleSnapshot.mockResolvedValue([
      { t: 1710000000000, T: 1710003600000, s: "BTC", i: "1h", o: "70000", c: "70500", h: "71000", l: "69000", v: "1000", n: 500 },
    ])
  })

  it("returns candle data array with defaults", async () => {
    const candles = await fetchCandlesForATR("BTC")
    expect(Array.isArray(candles)).toBe(true)
    if (candles.length > 0) {
      expect(candles[0]).toHaveProperty("timestamp")
      expect(typeof candles[0].close).toBe("number")
    }
  })

  it("returns candles with custom interval", async () => {
    const candles = await fetchCandlesForATR("BTC", "15m", 10)
    expect(Array.isArray(candles)).toBe(true)
  })
})
