import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

beforeEach(() => {
  vi.clearAllMocks()
})

const mockCoinData = {
  circulating_supply: 19500000,
  max_supply: 21000000,
  total_supply: 21000000,
  market_cap_rank: 1,
  market_data: {
    market_cap: { usd: 1000000000000 },
    total_volume: { usd: 50000000000 },
  },
}

let toolsModule: typeof import("@/lib/agent/due-diligence/tools/onchain/coingecko") | null = null
async function getModule() {
  if (!toolsModule) {
    toolsModule = await import("@/lib/agent/due-diligence/tools/onchain/coingecko")
  }
  return toolsModule
}

describe("get_token_supply tool", () => {
  it("returns supply data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockCoinData,
    })
    const mod = await getModule()
    const tool = mod.getTokenSupplyTool()
    const result = await tool.execute({ coingeckoId: "bitcoin" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("circulatingSupply", 19500000)
    expect(result.data).toHaveProperty("maxSupply", 21000000)
    expect(result.data).toHaveProperty("totalSupply", 21000000)
  })

  it("returns error for unknown coin", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    const mod = await getModule()
    const tool = mod.getTokenSupplyTool()
    const result = await tool.execute({ coingeckoId: "nonexistent" })
    expect(result.success).toBe(false)
  })
})

describe("get_market_cap tool", () => {
  it("returns market cap data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockCoinData,
    })
    const mod = await getModule()
    const tool = mod.getMarketCapTool()
    const result = await tool.execute({ coingeckoId: "bitcoin" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("marketCapUsd", 1000000000000)
    expect(result.data).toHaveProperty("marketCapRank", 1)
  })
})

describe("get_24h_volume tool", () => {
  it("returns 24h volume data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockCoinData,
    })
    const mod = await getModule()
    const tool = mod.get24hVolumeTool()
    const result = await tool.execute({ coingeckoId: "bitcoin" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("totalVolumeUsd", 50000000000)
  })
})

describe("tool parameter validation", () => {
  it("rejects missing coingeckoId", async () => {
    const mod = await getModule()
    const tool = mod.getTokenSupplyTool()
    expect(() => tool.parameters.parse({})).toThrow()
  })
})
