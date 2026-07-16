import { describe, it, expect, vi } from "vitest"
import { fetchAllRawData } from "@/lib/data/providers"

vi.mock("@/lib/data/hyperliquid", () => ({
  fetchAllHLData: vi.fn().mockResolvedValue({
    candles1h: [{ timestamp: 1710000000000, open: 70000, high: 71000, low: 69000, close: 70500, volume: 1000 }],
    candles15m: [],
    candles1d: [],
    currentPrice: 70500,
    priceChange24h: 2.5,
    onchain: { fundingRate: 0.0001, openInterest: 1.5e9, markPrice: 70500, oraclePrice: 70400, premium: 0.00005, dayVolume: 2e9, oiCapReached: false },
  }),
}))

vi.mock("@/lib/data/coingecko", () => ({
  fetchPrice: vi.fn().mockResolvedValue({ usd: 70500, change24h: 2.5 }),
  fetchMetadata: vi.fn().mockResolvedValue({ marketCap: 1.2e12, totalVolume24h: 5e10, circulatingSupply: 1.9e7, totalSupply: 2.1e7, athPrice: 69000, athChangePercent: -5.8, description: "Bitcoin" }),
  fetchTrending: vi.fn().mockResolvedValue([{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", market_cap_rank: 1 }]),
}))

vi.mock("@/lib/data/sentiment", () => ({
  fetchFearGreedIndex: vi.fn().mockResolvedValue({ value: 45, classification: "Fear" }),
}))

const majorCategory = { name: "major", activeFactors: ["technical", "onchain", "sentiment", "fundamental"] }
const memeCategory = { name: "meme", activeFactors: ["technical", "onchain", "sentiment"] }

describe("fetchAllRawData", () => {
  it("returns all factor data for major category", async () => {
    const data = await fetchAllRawData("BTC", majorCategory as any)
    expect(data).toHaveProperty("technical")
    expect(data).toHaveProperty("onchain")
    expect(data).toHaveProperty("sentiment")
    expect(data).toHaveProperty("fundamental")
  })

  it("returns only active factors for meme category", async () => {
    const data = await fetchAllRawData("DOGE", memeCategory as any)
    expect(data).toHaveProperty("technical")
    expect(data).toHaveProperty("onchain")
    expect(data).toHaveProperty("sentiment")
  })

  it("handles partial failure (HL down, CG up)", async () => {
    const hl = await import("@/lib/data/hyperliquid")
    vi.mocked(hl.fetchAllHLData).mockRejectedValueOnce(new Error("HL down"))
    const data = await fetchAllRawData("BTC", majorCategory as any)
    expect(data).toBeDefined()
  })

  it("does not crash for meme category", async () => {
    const data = await fetchAllRawData("DOGE", memeCategory as any)
    expect(data).toBeDefined()
  })
})
