import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CandleData } from "@/lib/data/types"
import type { RiskThresholds } from "@/lib/agent/types"

// Mock data layer modules; hoisted before any imports resolve
const mockFetchCandlesForATR = vi.hoisted(() => vi.fn())
const mockFetchMarkPrice = vi.hoisted(() => vi.fn())
const mockFetchOnchainData = vi.hoisted(() => vi.fn())
const mockFetchCandles = vi.hoisted(() => vi.fn())
const mockAllMids = vi.hoisted(() => vi.fn())
const mockL2Book = vi.hoisted(() => vi.fn())
const mockGetRiskThresholds = vi.hoisted(() => vi.fn())
const mockEnvDefaults = vi.hoisted(() => vi.fn())
const mockQueryGraphPatterns = vi.hoisted(() => vi.fn())

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(() => ({ allMids: mockAllMids, l2Book: mockL2Book })),
  fetchCandlesForATR: mockFetchCandlesForATR,
  fetchMarkPrice: mockFetchMarkPrice,
  fetchOnchainData: mockFetchOnchainData,
  fetchCandles: mockFetchCandles,
}))

vi.mock("@/lib/db/risk-thresholds", () => ({
  getRiskThresholds: mockGetRiskThresholds,
  envDefaults: mockEnvDefaults,
}))

vi.mock("@/lib/db/graph-memory", () => ({
  queryGraphPatterns: mockQueryGraphPatterns,
}))

import { buildPlanningToolRegistry } from "@/lib/agent/planning/tools"

const makeFlatCandles = (n: number): CandleData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 1000,
  }))

const DEFAULT_THRESHOLDS: RiskThresholds = {
  confidence_threshold: 70,
  max_position_usdc: 100,
  max_leverage: 10,
  risk_per_trade_percent: 1,
}

const CTX = { walletAddress: "0xabc", userId: "user_1", asset: "ETH", equity: 10000 }

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchCandlesForATR.mockResolvedValue(makeFlatCandles(20))
  mockFetchMarkPrice.mockResolvedValue(200)
  mockFetchOnchainData.mockResolvedValue({
    fundingRate: 0.0001,
    openInterest: 100_000_000,
    markPrice: 65000,
    oraclePrice: 65000,
    premium: null,
    dayVolume: 5_000_000,
    oiCapReached: false,
  })
  // reason: T3 funding tools read candles[-1] and candles[-25] for 24h price change
  mockFetchCandles.mockResolvedValue(makeFlatCandles(30))
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
  mockQueryGraphPatterns.mockResolvedValue([])
})

describe("buildPlanningToolRegistry", () => {
  it("merges risk-engine + market-data + T3 tools into one registry", () => {
    const registry = buildPlanningToolRegistry(CTX)
    expect(Object.keys(registry).sort()).toEqual([
      "analyze_funding_regime",
      "assess_cascade_risk",
      "cap_leverage",
      "check_liquidation_zones",
      "compute_atr",
      "compute_position_size",
      "compute_sltp",
      "detect_oi_funding_divergence",
      "get_candles",
      "get_graph_patterns",
      "get_mark_price",
      "get_orderbook_depth",
      "get_risk_thresholds",
      "web_search",
    ])
  })

  it("defines a valid ToolDefinition for every tool", () => {
    const registry = buildPlanningToolRegistry(CTX)
    for (const [name, tool] of Object.entries(registry)) {
      expect(tool.name).toBe(name)
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe("function")
    }
  })

  it("every tool executes successfully with minimal params against ctx", async () => {
    const registry = buildPlanningToolRegistry(CTX)
    const paramsFor = (name: string) => {
      switch (name) {
        case "compute_sltp":
          return { entry: 100, atr: 10, side: "long" }
        case "compute_position_size":
          return { entry: 100, stopLoss: 95, riskPercent: 1 }
        case "cap_leverage":
          return { llmSuggested: 5, maxAllowed: 10 }
        case "get_orderbook_depth":
          return { asset: "ETH" }
        // reason: T3 tools take asset per call — their schemas require it, no ctx fallback (verified in funding.ts/liquidation.ts/web-search.ts)
        case "analyze_funding_regime":
        case "detect_oi_funding_divergence":
        case "assess_cascade_risk":
          return { asset: "ETH" }
        case "check_liquidation_zones":
          return { asset: "ETH", entryPrice: 65000, stopLoss: 64000 }
        case "web_search":
          return { query: "BTC news today" }
        default:
          return {}
      }
    }

    // reason: web_search reads EXA_API_KEY then calls global fetch; stub both so the tool succeeds deterministically
    vi.stubEnv("EXA_API_KEY", "test-key")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "t", url: "u", text: "x" }] }),
      })
    )
    try {
      for (const [name, tool] of Object.entries(registry)) {
        const params = tool.parameters.parse(paramsFor(name))
        const result = await tool.execute(params)
        expect(result.success, `${name} failed: ${result.error}`).toBe(true)
        expect(typeof result.metadata.latencyMs).toBe("number")
        expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it("ctx.equity is used by compute_position_size when equity omitted", async () => {
    const registry = buildPlanningToolRegistry(CTX)
    const params = registry.compute_position_size.parameters.parse({ entry: 100, stopLoss: 95, riskPercent: 1 })
    const result = await registry.compute_position_size.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ positionSizeUsdc: 2000, positionSizeContracts: 20 })
  })
})
