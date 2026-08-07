import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/data/sentiment/alternativeme", () => ({
  fetchGlobalMarket: vi.fn(),
  fetchAssetMomentum: vi.fn(),
}))

import { fetchGlobalMarket, fetchAssetMomentum } from "@/lib/data/sentiment/alternativeme"
import { getGlobalMarket, getAssetMomentum } from "@/lib/agent/due-diligence/tools/sentiment/alternativeme"

describe("get_global_market tool", () => {
  beforeEach(() => {
    vi.mocked(fetchGlobalMarket).mockResolvedValue({
      total_market_cap: 2500000000000,
      total_volume_24h: 120000000000,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns market data on success", async () => {
    const result = await getGlobalMarket.execute({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ total_market_cap: 2500000000000, total_volume_24h: 120000000000 })
    expect(result.metadata.source).toBe("altme")
  })

  it("returns error when fetchGlobalMarket throws", async () => {
    vi.mocked(fetchGlobalMarket).mockRejectedValue(new Error("API error"))
    const result = await getGlobalMarket.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })

  it("handles null data gracefully", async () => {
    vi.mocked(fetchGlobalMarket).mockResolvedValue({ total_market_cap: null, total_volume_24h: null })
    const result = await getGlobalMarket.execute({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ total_market_cap: null, total_volume_24h: null })
  })
})

describe("get_asset_momentum tool", () => {
  beforeEach(() => {
    vi.mocked(fetchAssetMomentum).mockResolvedValue({
      price_usd: 65000,
      percent_change_1h: 0.5,
      percent_change_24h: -2.3,
      percent_change_7d: 8.1,
      volume_24h_usd: 28000000000,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns momentum data on success", async () => {
    const result = await getAssetMomentum.execute({ coinId: 1 })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      price_usd: 65000,
      percent_change_1h: 0.5,
      percent_change_24h: -2.3,
      percent_change_7d: 8.1,
      volume_24h_usd: 28000000000,
    })
    expect(result.metadata.source).toBe("altme")
    expect(fetchAssetMomentum).toHaveBeenCalledWith(1)
  })

  it("returns error when fetchAssetMomentum throws", async () => {
    vi.mocked(fetchAssetMomentum).mockRejectedValue(new Error("API error"))
    const result = await getAssetMomentum.execute({ coinId: 1 })
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })
})
