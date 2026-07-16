import { describe, it, expect, vi } from "vitest"
import { fetchPrice, fetchTrending, fetchMetadata } from "@/lib/data/coingecko"

describe("fetchPrice", () => {
  it("returns price data for a valid coin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ bitcoin: { usd: 65000, usd_24h_change: 2.5 } }),
    }))
    const result = await fetchPrice("bitcoin")
    expect(result).toHaveProperty("usd")
    expect(result).toHaveProperty("change24h")
    expect(result!.usd).toBe(65000)
    vi.unstubAllGlobals()
  })

  it("returns null on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }))
    const result = await fetchPrice("bitcoin")
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe("fetchTrending", () => {
  it("returns trending assets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ coins: [{ item: { id: "bitcoin", symbol: "BTC", name: "Bitcoin", market_cap_rank: 1 } }] }),
    }))
    const result = await fetchTrending()
    expect(Array.isArray(result)).toBe(true)
    vi.unstubAllGlobals()
  })

  it("returns empty array on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")))
    const result = await fetchTrending()
    expect(result).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe("fetchMetadata", () => {
  it("returns metadata for a valid coin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        market_data: { market_cap: { usd: 1.2e12 }, total_volume: { usd: 5e10 }, circulating_supply: 1.9e7, total_supply: 2.1e7, ath: { usd: 69000 }, ath_change_percentage: { usd: -5.8 } },
        description: { en: "Bitcoin is digital gold." },
      }),
    }))
    const result = await fetchMetadata("bitcoin")
    expect(result).toHaveProperty("marketCap")
    expect(result).toHaveProperty("description")
    vi.unstubAllGlobals()
  })

  it("returns null caps on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))
    const result = await fetchMetadata("bitcoin")
    expect(result.marketCap).toBeNull()
    vi.unstubAllGlobals()
  })
})
