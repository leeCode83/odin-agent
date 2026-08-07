import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockMetaAndAssetCtxs, mockAllMids, mockL2Book, mockPerpsAtOpenInterestCap } = vi.hoisted(() => ({
  mockMetaAndAssetCtxs: vi.fn().mockResolvedValue([
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 1 }], marginTables: [], collateralToken: 0 },
    [{ prevDayPx: "70000", dayNtlVlm: "2000000000", markPx: "70500", midPx: "70450", funding: "0.0001", openInterest: "1500000000", premium: "0.00005", oraclePx: "70400", impactPxs: null, dayBaseVlm: "28571" }],
  ]),
  mockAllMids: vi.fn().mockResolvedValue({ BTC: "70500", ETH: "3500" }),
  mockL2Book: vi.fn().mockResolvedValue({
    coin: "BTC",
    levels: [
      [{ px: "70500", sz: "10", n: 2 }],
      [{ px: "70400", sz: "15", n: 2 }],
    ],
    time: 1710000000000,
  }),
  mockPerpsAtOpenInterestCap: vi.fn().mockResolvedValue([]),
}))

vi.mock("@nktkas/hyperliquid", () => ({
  HttpTransport: vi.fn().mockImplementation(function () { return {} }),
  InfoClient: vi.fn().mockImplementation(function () {
    return {
      metaAndAssetCtxs: mockMetaAndAssetCtxs,
      allMids: mockAllMids,
      l2Book: mockL2Book,
      perpsAtOpenInterestCap: mockPerpsAtOpenInterestCap,
    }
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

let toolsModule: typeof import("@/lib/agent/due-diligence/tools/onchain/hyperliquid") | null = null
async function getModule() {
  if (!toolsModule) {
    toolsModule = await import("@/lib/agent/due-diligence/tools/onchain/hyperliquid")
  }
  return toolsModule
}

describe("get_funding_rate tool", () => {
  it("returns funding rate and related data", async () => {
    const mod = await getModule()
    const tool = mod.getFundingRateTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("fundingRate", 0.0001)
    expect(result.data).toHaveProperty("markPrice", 70500)
    expect(result.data).toHaveProperty("oraclePrice", 70400)
    expect(result.data).toHaveProperty("premium", 0.00005)
    expect(result.metadata.source).toBe("hyperliquid")
    expect(typeof result.metadata.latencyMs).toBe("number")
  })

  it("validates asset parameter", async () => {
    const mod = await getModule()
    const tool = mod.getFundingRateTool()
    expect(() => tool.parameters.parse({})).toThrow()
    expect(() => tool.parameters.parse({ asset: 123 })).toThrow()
  })

  it("returns error for unknown asset", async () => {
    mockMetaAndAssetCtxs.mockResolvedValueOnce([
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 1 }], marginTables: [], collateralToken: 0 },
      [{ prevDayPx: "70000", dayNtlVlm: "2000000000", markPx: "70500", midPx: "70450", funding: "0.0001", openInterest: "1500000000", premium: "0.00005", oraclePx: "70400", impactPxs: null, dayBaseVlm: "28571" }],
    ])
    const mod = await getModule()
    const tool = mod.getFundingRateTool()
    const result = await tool.execute({ asset: "DOGE" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("not found")
  })
})

describe("get_open_interest tool", () => {
  it("returns open interest for asset", async () => {
    const mod = await getModule()
    const tool = mod.getOpenInterestTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("openInterest", 1500000000)
    expect(result.data).toHaveProperty("oiCapReached", false)
  })

  it("validates asset parameter", async () => {
    const mod = await getModule()
    const tool = mod.getOpenInterestTool()
    expect(() => tool.parameters.parse({})).toThrow()
  })
})

describe("get_orderbook_depth tool", () => {
  it("returns order book depth", async () => {
    const mod = await getModule()
    const tool = mod.getOrderbookDepthTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("asset", "BTC")
    expect(result.data).toHaveProperty("bids")
    expect(result.data).toHaveProperty("asks")
    expect(Array.isArray(result.data.bids)).toBe(true)
    expect(Array.isArray(result.data.asks)).toBe(true)
  })

  it("returns basic depth when l2Book fails", async () => {
    mockL2Book.mockRejectedValueOnce(new Error("API error"))
    const mod = await getModule()
    const tool = mod.getOrderbookDepthTool()
    const result = await tool.execute({ asset: "BTC", depth: 5 })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("asset", "BTC")
    expect(result.data).toHaveProperty("midPrice", 70500)
  })

  it("rejects invalid depth in schema", async () => {
    const mod = await getModule()
    const tool = mod.getOrderbookDepthTool()
    expect(() => tool.parameters.parse({ asset: "BTC", depth: -1 })).toThrow()
    expect(() => tool.parameters.parse({ asset: "BTC", depth: 0 })).toThrow()
    expect(() => tool.parameters.parse({ asset: "BTC", depth: 100 })).toThrow()
  })
})

describe("get_mark_price tool", () => {
  it("returns mark price for asset", async () => {
    const mod = await getModule()
    const tool = mod.getMarkPriceTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("markPrice", 70500)
    expect(result.data).toHaveProperty("asset", "BTC")
  })

  it("returns error for unknown asset", async () => {
    mockAllMids.mockResolvedValueOnce({ BTC: "70500" })
    const mod = await getModule()
    const tool = mod.getMarkPriceTool()
    const result = await tool.execute({ asset: "DOGE" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("not found")
  })
})
