import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHLClient, fetchCandles, fetchOnchainData, fetchMarkPrice, fetchUserEquity, fetchUserBalance, fetchCandlesForATR } from "@/lib/data/hyperliquid"

const { mockCandleSnapshot, mockMetaAndAssetCtxs, mockFundingHistory, mockPerpsAtOpenInterestCap, mockAllMids, mockClearinghouseState } = vi.hoisted(() => ({
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
  mockClearinghouseState: vi.fn().mockResolvedValue({
    crossMarginSummary: { accountValue: "1009", totalMarginUsed: "559", totalNtlPos: "450", totalRawUsd: "0" },
    crossMaintenanceMarginUsed: "120",
    withdrawable: "450",
    assetPositions: [{
      type: "oneWay",
      position: {
        coin: "BTC",
        szi: "0.1",
        positionValue: "7050",
        entryPx: "70000",
        unrealizedPnl: "50",
        returnOnEquity: "0.1",
        liquidationPx: "60000",
        marginUsed: "350",
        leverage: { type: "cross", value: 20, rawUsd: "350" },
        cumFunding: { allTime: "1.5", sinceOpen: "0.5", sinceChange: "0.1" },
      },
    }],
    marginSummary: { accountValue: "1009", totalNtlPos: "0", totalRawUsd: "1009", totalMarginUsed: "0" },
    time: 1710000000000,
  }),
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
      clearinghouseState: mockClearinghouseState,
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
  it("returns withdrawable balance from clearing state", async () => {
    const equity = await fetchUserEquity("0x123")
    expect(typeof equity).toBe("number")
    expect(equity).toBe(450)
  })

  it("throws for null state (non-existent or pruned account)", async () => {
    mockClearinghouseState.mockResolvedValueOnce(null)
    await expect(fetchUserEquity("")).rejects.toThrow(/No clearinghouse state/)
  })
})

describe("fetchUserBalance", () => {
  it("returns full balance detail object", async () => {
    const balance = await fetchUserBalance("0x123")
    expect(balance).toHaveProperty("walletAddress", "0x123")
    expect(balance).toHaveProperty("withdrawable", 450)
    expect(balance).toHaveProperty("accountValue", 1009)
    expect(balance).toHaveProperty("totalMarginUsed", 559)
    expect(balance).toHaveProperty("openPositions", 1)
    expect(balance).toHaveProperty("crossMaintenanceMarginUsed", 120)
    expect(balance.positions).toHaveLength(1)
    expect(balance.positions[0].coin).toBe("BTC")
  })

  it("returns all fields as numbers", async () => {
    const balance = await fetchUserBalance("0x123")
    expect(typeof balance.withdrawable).toBe("number")
    expect(typeof balance.accountValue).toBe("number")
    expect(typeof balance.totalMarginUsed).toBe("number")
    expect(typeof balance.openPositions).toBe("number")
    expect(typeof balance.crossMaintenanceMarginUsed).toBe("number")
    expect(Array.isArray(balance.positions)).toBe(true)
    expect(Number.isNaN(balance.withdrawable)).toBe(false)
    expect(Number.isNaN(balance.accountValue)).toBe(false)
  })

  it("throws for null state (non-existent or pruned account)", async () => {
    mockClearinghouseState.mockResolvedValueOnce(null)
    await expect(fetchUserBalance("")).rejects.toThrow(/No clearinghouse state/)
  })

  it("handles withdrawable as number (not string)", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "1009", totalMarginUsed: "559", totalNtlPos: "450", totalRawUsd: "0" },
      crossMaintenanceMarginUsed: "120",
      withdrawable: 1000,
      assetPositions: [],
      marginSummary: { accountValue: "1009", totalNtlPos: "0", totalRawUsd: "1009", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0xnum")
    expect(balance.withdrawable).toBe(1000)
    expect(balance.accountValue).toBe(1009)
  })

  it("handles withdrawable as null", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
      crossMaintenanceMarginUsed: "0",
      withdrawable: null,
      assetPositions: [],
      marginSummary: { accountValue: "500", totalNtlPos: "0", totalRawUsd: "500", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0xnull")
    expect(balance.withdrawable).toBe(0)
    expect(balance.accountValue).toBe(500)
  })

  it("handles withdrawable as undefined (field missing)", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
      crossMaintenanceMarginUsed: "0",
      assetPositions: [],
      marginSummary: { accountValue: "500", totalNtlPos: "0", totalRawUsd: "500", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0xundef")
    expect(balance.withdrawable).toBe(0)
    expect(balance.accountValue).toBe(500)
  })

  it("returns zero openPositions when assetPositions is empty", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
      crossMaintenanceMarginUsed: "0",
      withdrawable: "500",
      assetPositions: [],
      marginSummary: { accountValue: "500", totalNtlPos: "0", totalRawUsd: "500", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0x456")
    expect(balance.openPositions).toBe(0)
    expect(balance.positions).toEqual([])
  })

  it("maps position fields correctly", async () => {
    const balance = await fetchUserBalance("0x123")
    const pos = balance.positions[0]
    expect(pos.coin).toBe("BTC")
    expect(pos.side).toBe("long")
    expect(pos.sizeAsset).toBe(0.1)
    expect(pos.sizeUsdc).toBe(7050)
    expect(pos.entryPrice).toBe(70000)
    expect(pos.unrealizedPnl).toBe(50)
    expect(pos.leverage).toBe(20)
    expect(pos.marginUsed).toBe(350)
    expect(pos.liquidationPrice).toBe(60000)
    expect(pos.returnOnEquity).toBe(0.1)
    expect(pos.fundingSinceOpen).toBe(0.5)
  })

  it("derives short side from negative szi", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "500" },
      crossMaintenanceMarginUsed: "0",
      withdrawable: "500",
      assetPositions: [{
        type: "oneWay",
        position: {
          coin: "ETH",
          szi: "-0.05",
          positionValue: "175",
          entryPx: "3500",
          unrealizedPnl: "-5",
          returnOnEquity: "-0.02",
          liquidationPx: "3200",
          marginUsed: "20",
          leverage: { type: "cross", value: 5, rawUsd: "20" },
          cumFunding: { allTime: "0.1", sinceOpen: "0.02", sinceChange: "0" },
        },
      }],
      marginSummary: { accountValue: "500", totalNtlPos: "0", totalRawUsd: "500", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0x789")
    expect(balance.positions[0].side).toBe("short")
    expect(balance.positions[0].sizeAsset).toBe(0.05)
  })

  it("handles null liquidationPx", async () => {
    mockClearinghouseState.mockResolvedValueOnce({
      crossMarginSummary: { accountValue: "500", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "500" },
      crossMaintenanceMarginUsed: "0",
      withdrawable: "500",
      assetPositions: [{
        type: "oneWay",
        position: {
          coin: "BTC",
          szi: "0.1",
          positionValue: "7050",
          entryPx: "70000",
          unrealizedPnl: "50",
          returnOnEquity: "0.1",
          liquidationPx: null,
          marginUsed: "350",
          leverage: { type: "cross", value: 20, rawUsd: "350" },
          cumFunding: { allTime: "1.5", sinceOpen: "0.5", sinceChange: "0.1" },
        },
      }],
      marginSummary: { accountValue: "500", totalNtlPos: "0", totalRawUsd: "500", totalMarginUsed: "0" },
      time: 1710000000000,
    })
    const balance = await fetchUserBalance("0xabc")
    expect(balance.positions[0].liquidationPrice).toBeNull()
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
