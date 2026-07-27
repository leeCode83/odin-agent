import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/data/sentiment/coingecko", () => ({
  fetchTrendingCoins: vi.fn(),
  fetchCoinData: vi.fn(),
  fetchCategoryPerformance: vi.fn(),
  fetchGlobalData: vi.fn(),
}))

import {
  fetchTrendingCoins,
  fetchCoinData,
  fetchCategoryPerformance,
  fetchGlobalData,
} from "@/lib/data/sentiment/coingecko"
import {
  getTrendingCoins,
  getCoinSentiment,
  getCategoryPerformance,
  getGlobalSentiment,
} from "@/lib/agent/tools/sentiment/coingecko"

describe("get_trending_coins tool", () => {
  beforeEach(() => {
    vi.mocked(fetchTrendingCoins).mockResolvedValue({ coins: [{ item: { id: "bitcoin", name: "Bitcoin" } }] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns trending coins on success", async () => {
    const result = await getTrendingCoins.execute({})
    expect(result.success).toBe(true)
    expect(result.metadata.source).toBe("coingecko")
    expect(result.data).toBeDefined()
  })

  it("returns error when fetchTrendingCoins throws", async () => {
    vi.mocked(fetchTrendingCoins).mockRejectedValue(new Error("API error"))
    const result = await getTrendingCoins.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })
})

describe("get_coin_sentiment tool", () => {
  beforeEach(() => {
    vi.mocked(fetchCoinData).mockResolvedValue({ id: "bitcoin", symbol: "btc" })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns coin data on success", async () => {
    const result = await getCoinSentiment.execute({ coinId: "bitcoin" })
    expect(result.success).toBe(true)
    expect(result.metadata.source).toBe("coingecko")
    expect(fetchCoinData).toHaveBeenCalledWith("bitcoin")
  })

  it("returns error when fetchCoinData throws", async () => {
    vi.mocked(fetchCoinData).mockRejectedValue(new Error("API error"))
    const result = await getCoinSentiment.execute({ coinId: "bitcoin" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })
})

describe("get_category_performance tool", () => {
  beforeEach(() => {
    vi.mocked(fetchCategoryPerformance).mockResolvedValue([{ id: "layer-1", name: "Layer 1" }])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns category data on success", async () => {
    const result = await getCategoryPerformance.execute({})
    expect(result.success).toBe(true)
    expect(result.metadata.source).toBe("coingecko")
    expect(result.data).toBeDefined()
  })

  it("returns error when fetchCategoryPerformance throws", async () => {
    vi.mocked(fetchCategoryPerformance).mockRejectedValue(new Error("API error"))
    const result = await getCategoryPerformance.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })
})

describe("get_global_sentiment tool", () => {
  beforeEach(() => {
    vi.mocked(fetchGlobalData).mockResolvedValue({ data: { active_cryptocurrencies: 15000 } })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns global data on success", async () => {
    const result = await getGlobalSentiment.execute({})
    expect(result.success).toBe(true)
    expect(result.metadata.source).toBe("coingecko")
    expect(result.data).toBeDefined()
  })

  it("returns error when fetchGlobalData throws", async () => {
    vi.mocked(fetchGlobalData).mockRejectedValue(new Error("API error"))
    const result = await getGlobalSentiment.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })
})
