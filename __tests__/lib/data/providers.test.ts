import { describe, it, expect, vi } from "vitest"
import { fetchAllRawData } from "@/lib/data/providers"
import type { CategoryConfig } from "@/lib/asset-categories"

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

vi.mock("@/lib/data/sentiment", () => ({
  fetchSentimentData: vi.fn().mockResolvedValue({
    fearGreedIndex: 45,
    fearGreedClassification: "Fear",
    trendingRank: 1,
  }),
}))

vi.mock("@/lib/data/fundamental", () => ({
  fetchFundamentalData: vi.fn().mockResolvedValue({
    marketCap: 1.2e12,
    totalVolume24h: 5e10,
    circulatingSupply: 1.9e7,
    totalSupply: 2.1e7,
    athPrice: 69000,
    athChangePercent: -5.8,
    description: "Bitcoin",
  }),
}))

vi.mock("@/lib/data/technical", () => ({
  fetchTechnicalData: vi.fn().mockImplementation(async (_asset: string, hlTechnical: unknown) => hlTechnical),
}))

vi.mock("@/lib/data/onchain", () => ({
  fetchOnchainData: vi.fn().mockImplementation(async (_asset: string, hlOnchain: unknown) => hlOnchain),
}))

const majorCategory = { name: "major", activeFactors: ["technical", "onchain", "sentiment", "fundamental"] }
const memeCategory = { name: "meme", activeFactors: ["technical", "onchain", "sentiment"] }

describe("fetchAllRawData", () => {
  it("returns all factor data for major category", async () => {
    const data = await fetchAllRawData("BTC", majorCategory as unknown as CategoryConfig)
    expect(data).toHaveProperty("technical")
    expect(data).toHaveProperty("onchain")
    expect(data).toHaveProperty("sentiment")
    expect(data).toHaveProperty("fundamental")
  })

  it("returns only active factors for meme category", async () => {
    const data = await fetchAllRawData("DOGE", memeCategory as unknown as CategoryConfig)
    expect(data).toHaveProperty("technical")
    expect(data).toHaveProperty("onchain")
    expect(data).toHaveProperty("sentiment")
  })

  it("handles partial failure (HL down, CG up)", async () => {
    const hl = await import("@/lib/data/hyperliquid")
    vi.mocked(hl.fetchAllHLData).mockRejectedValueOnce(new Error("HL down"))

    const technical = await import("@/lib/data/technical")
    vi.mocked(technical.fetchTechnicalData).mockResolvedValueOnce(null)
    const onchain = await import("@/lib/data/onchain")
    vi.mocked(onchain.fetchOnchainData).mockResolvedValueOnce(null)

    const data = await fetchAllRawData("BTC", majorCategory as unknown as CategoryConfig)
    expect(data).toBeDefined()
  })

  it("does not crash for meme category", async () => {
    const data = await fetchAllRawData("DOGE", memeCategory as unknown as CategoryConfig)
    expect(data).toBeDefined()
  })
})
