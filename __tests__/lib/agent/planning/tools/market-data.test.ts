import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import type { CandleData } from "@/lib/data/types"
import type { RiskThresholds } from "@/lib/agent/types"

// Mock data layer modules; hoisted before any imports resolve
const mockFetchCandlesForATR = vi.hoisted(() => vi.fn())
const mockFetchMarkPrice = vi.hoisted(() => vi.fn())
const mockAllMids = vi.hoisted(() => vi.fn())
const mockL2Book = vi.hoisted(() => vi.fn())
const mockGetRiskThresholds = vi.hoisted(() => vi.fn())
const mockEnvDefaults = vi.hoisted(() => vi.fn())
const mockQueryGraphPatterns = vi.hoisted(() => vi.fn())

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(() => ({ allMids: mockAllMids, l2Book: mockL2Book })),
  fetchCandlesForATR: mockFetchCandlesForATR,
  fetchMarkPrice: mockFetchMarkPrice,
}))

vi.mock("@/lib/db/risk-thresholds", () => ({
  getRiskThresholds: mockGetRiskThresholds,
  envDefaults: mockEnvDefaults,
}))

vi.mock("@/lib/db/graph-memory", () => ({
  queryGraphPatterns: mockQueryGraphPatterns,
}))

import { buildMarketDataTools } from "@/lib/agent/planning/tools/market-data"

const makeCandles = (n: number): CandleData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000 + i * 10,
  }))

const DEFAULT_THRESHOLDS: RiskThresholds = {
  confidence_threshold: 70,
  max_position_usdc: 100,
  max_leverage: 10,
  risk_per_trade_percent: 1,
}

const CTX = { asset: "ETH", userId: "user_1" }

const tool = (name: string) => buildMarketDataTools(CTX).find((t) => t.name === name)!

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchCandlesForATR.mockResolvedValue(makeCandles(20))
  mockFetchMarkPrice.mockResolvedValue(200)
  mockAllMids.mockResolvedValue({ ETH: "65000" })
  mockL2Book.mockResolvedValue({
    levels: [
      [
        { px: "65010", sz: "1.5", n: 2 },
        { px: "65020", sz: "2.5", n: 3 },
      ],
      [
        { px: "64990", sz: "1.2", n: 4 },
        { px: "64980", sz: "2.2", n: 5 },
      ],
    ],
  })
  mockGetRiskThresholds.mockResolvedValue(DEFAULT_THRESHOLDS)
  mockEnvDefaults.mockReturnValue(DEFAULT_THRESHOLDS)
  mockQueryGraphPatterns.mockResolvedValue([
    { pattern: "RSI_BOUNCE", outcome: "profit", frequency: 3 },
  ])
})

describe("get_mark_price", () => {
  it("returns mark price with hyperliquid source", async () => {
    const params = tool("get_mark_price").parameters.parse({ asset: "BTC" })
    const result = await tool("get_mark_price").execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ markPrice: 200 })
    expect(mockFetchMarkPrice).toHaveBeenCalledWith("BTC")
    expect(result.metadata.source).toBe("hyperliquid")
  })

  it("falls back to ctx.asset when params omit asset", async () => {
    const params = tool("get_mark_price").parameters.parse({})
    const result = await tool("get_mark_price").execute(params)

    expect(result.success).toBe(true)
    expect(mockFetchMarkPrice).toHaveBeenCalledWith("ETH")
  })

  it("returns success:false when fetch fails", async () => {
    mockFetchMarkPrice.mockRejectedValue(new Error("rate limited"))
    const params = tool("get_mark_price").parameters.parse({ asset: "BTC" })
    const result = await tool("get_mark_price").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("rate limited")
  })
})

describe("get_candles", () => {
  it("returns candles with 1h/20 defaults", async () => {
    const params = tool("get_candles").parameters.parse({ asset: "BTC" })
    const result = await tool("get_candles").execute(params)

    expect(result.success).toBe(true)
    expect(result.data.candles).toHaveLength(20)
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("BTC", "1h", 20)
    expect(result.metadata.source).toBe("hyperliquid")
  })

  it("honors interval and count overrides", async () => {
    const params = tool("get_candles").parameters.parse({ asset: "BTC", interval: "4h", count: 50 })
    const result = await tool("get_candles").execute(params)

    expect(result.success).toBe(true)
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("BTC", "4h", 50)
  })

  it("falls back to ctx.asset when params omit asset", async () => {
    const params = tool("get_candles").parameters.parse({})
    const result = await tool("get_candles").execute(params)

    expect(result.success).toBe(true)
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("ETH", "1h", 20)
  })

  it("returns success:false when fetch fails", async () => {
    mockFetchCandlesForATR.mockRejectedValue(new Error("timeout"))
    const params = tool("get_candles").parameters.parse({ asset: "BTC" })
    const result = await tool("get_candles").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("timeout")
  })
})

describe("get_risk_thresholds", () => {
  it("returns thresholds from the database", async () => {
    const params = tool("get_risk_thresholds").parameters.parse({ userId: "user_2" })
    const result = await tool("get_risk_thresholds").execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ thresholds: DEFAULT_THRESHOLDS })
    expect(mockGetRiskThresholds).toHaveBeenCalledWith("user_2")
  })

  it("falls back to ctx.userId when params omit userId", async () => {
    const params = tool("get_risk_thresholds").parameters.parse({})
    const result = await tool("get_risk_thresholds").execute(params)

    expect(result.success).toBe(true)
    expect(mockGetRiskThresholds).toHaveBeenCalledWith("user_1")
  })

  it("falls back to envDefaults when DB returns nothing", async () => {
    mockGetRiskThresholds.mockResolvedValue(null)
    const params = tool("get_risk_thresholds").parameters.parse({})
    const result = await tool("get_risk_thresholds").execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ thresholds: DEFAULT_THRESHOLDS })
  })

  it("returns success:false when thresholds lookup fails", async () => {
    mockGetRiskThresholds.mockRejectedValue(new Error("db down"))
    const params = tool("get_risk_thresholds").parameters.parse({})
    const result = await tool("get_risk_thresholds").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("db down")
  })
})

describe("get_graph_patterns", () => {
  it("returns patterns from graph memory", async () => {
    const params = tool("get_graph_patterns").parameters.parse({ asset: "BTC", category: "defi", signals: ["RSI_BOUNCE"] })
    const result = await tool("get_graph_patterns").execute(params)

    expect(result.success).toBe(true)
    expect(result.data.patterns).toEqual([
      { pattern: "RSI_BOUNCE", outcome: "profit", frequency: 3 },
    ])
    expect(mockQueryGraphPatterns).toHaveBeenCalledWith("BTC", "defi", ["RSI_BOUNCE"])
  })

  it("falls back to ctx.asset and empty category/signals when omitted", async () => {
    const params = tool("get_graph_patterns").parameters.parse({})
    const result = await tool("get_graph_patterns").execute(params)

    expect(result.success).toBe(true)
    expect(mockQueryGraphPatterns).toHaveBeenCalledWith("ETH", "", [])
  })

  it("returns success:false when query fails", async () => {
    mockQueryGraphPatterns.mockRejectedValue(new Error("graph unavailable"))
    const params = tool("get_graph_patterns").parameters.parse({ asset: "BTC" })
    const result = await tool("get_graph_patterns").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("graph unavailable")
  })
})

describe("get_orderbook_depth", () => {
  it("is the re-exported onchain tool with hyperliquid source", async () => {
    const params = tool("get_orderbook_depth").parameters.parse({ asset: "ETH" })
    const result = await tool("get_orderbook_depth").execute(params)

    expect(result.success).toBe(true)
    expect(result.data.asset).toBe("ETH")
    expect(result.data.midPrice).toBe(65000)
    expect(result.data.bids).toHaveLength(2)
    expect(result.data.asks).toHaveLength(2)
    expect(result.metadata.source).toBe("hyperliquid")
  })

  it("returns success:false when mid price lookup fails", async () => {
    mockAllMids.mockRejectedValue(new Error("network error"))
    const params = tool("get_orderbook_depth").parameters.parse({ asset: "ETH" })
    const result = await tool("get_orderbook_depth").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("network error")
  })

  it("returns success:false for unknown asset", async () => {
    mockAllMids.mockResolvedValue({ ETH: "65000" })
    const params = tool("get_orderbook_depth").parameters.parse({ asset: "DOGE" })
    const result = await tool("get_orderbook_depth").execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toContain("Mid price not found")
  })
})

describe("buildMarketDataTools", () => {
  it("returns 5 tools (no get_equity) with metadata and described params", () => {
    const tools = buildMarketDataTools(CTX)
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_candles",
      "get_graph_patterns",
      "get_mark_price",
      "get_orderbook_depth",
      "get_risk_thresholds",
    ])
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.execute).toBe("function")
      const shape = (t.parameters as z.ZodObject<Record<string, z.ZodTypeAny>>).shape
      for (const field of Object.values(shape)) {
        expect(field.description).toBeDefined()
      }
    }
  })
})
