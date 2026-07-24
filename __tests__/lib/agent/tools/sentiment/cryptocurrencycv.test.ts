import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  getAiSentiment,
  getNarratives,
  getTrendingTopics,
  getTwitterSentiment,
  getAiResearch,
  getNews,
} from "@/lib/agent/tools/sentiment/cryptocurrencycv"

function mockFetchOnce(data: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  })
}

function mockFetchError(message: string) {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message))
}

describe("cryptocurrencycv tools", () => {
  beforeEach(() => {
    mockFetchOnce({ status: "ok" })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("getAiSentiment", () => {
    it("fetches /api/sentiment and returns data", async () => {
      mockFetchOnce({ sentiment: "bullish", score: 75 })
      const result = await getAiSentiment.execute({})
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ sentiment: "bullish", score: 75 })
      expect(result.metadata.source).toBe("cryptocurrency.cv")
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/sentiment")
      )
    })

    it("returns error on HTTP 500", async () => {
      mockFetchOnce({}, 500)
      const result = await getAiSentiment.execute({})
      expect(result.success).toBe(false)
      expect(result.error).toContain("500")
    })

    it("returns error on network failure", async () => {
      mockFetchError("Network error")
      const result = await getAiSentiment.execute({})
      expect(result.success).toBe(false)
      expect(result.error).toContain("Network error")
    })
  })

  describe("getNarratives", () => {
    it("fetches /api/narratives and returns data", async () => {
      mockFetchOnce({ narratives: ["AI", "DeFi"] })
      const result = await getNarratives.execute({})
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ narratives: ["AI", "DeFi"] })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/narratives")
      )
    })
  })

  describe("getTrendingTopics", () => {
    it("fetches /api/trending and returns data", async () => {
      mockFetchOnce({ trending: ["BTC", "ETH"] })
      const result = await getTrendingTopics.execute({})
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ trending: ["BTC", "ETH"] })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/trending")
      )
    })
  })

  describe("getTwitterSentiment", () => {
    it("fetches /api/social/x/sentiment without coin param", async () => {
      mockFetchOnce({ sentiment: "neutral" })
      const result = await getTwitterSentiment.execute({})
      expect(result.success).toBe(true)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/social/x/sentiment")
      )
    })

    it("passes coin query param when provided", async () => {
      mockFetchOnce({ sentiment: "bullish" })
      await getTwitterSentiment.execute({ coin: "BTC" })
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(url).toContain("/api/social/x/sentiment")
      expect(url).toContain("coin=BTC")
    })
  })

  describe("getAiResearch", () => {
    it("fetches /api/ai/research with topic param", async () => {
      mockFetchOnce({ research: "AI agents in crypto" })
      const result = await getAiResearch.execute({ topic: "AI agents" })
      expect(result.success).toBe(true)
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(url).toContain("/api/ai/research")
      expect(url).toContain(encodeURIComponent("AI agents"))
    })
  })

  describe("getNews", () => {
    it("fetches /api/news without limit", async () => {
      mockFetchOnce({ articles: [] })
      const result = await getNews.execute({})
      expect(result.success).toBe(true)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/news")
      )
    })

    it("passes limit query param when provided", async () => {
      mockFetchOnce({ articles: [{ title: "Test" }] })
      await getNews.execute({ limit: 5 })
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(url).toContain("limit=5")
    })
  })
})
