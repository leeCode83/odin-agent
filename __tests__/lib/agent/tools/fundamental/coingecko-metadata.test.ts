import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { coingeckoMetadataTools } from "@/lib/agent/due-diligence/tools/fundamental/coingecko-metadata"

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("get_coin_metadata", () => {
  const tool = coingeckoMetadataTools.find((t) => t.name === "get_coin_metadata")!

  it("returns metadata with name, description, links, categories", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: "Bitcoin",
        description: { en: "Bitcoin is a decentralized cryptocurrency" },
        links: { homepage: ["https://bitcoin.org"] },
        categories: ["Cryptocurrency", "Proof of Work (PoW)"],
      }),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      name: "Bitcoin",
      description: "Bitcoin is a decentralized cryptocurrency",
      links: { homepage: ["https://bitcoin.org"] },
      categories: ["Cryptocurrency", "Proof of Work (PoW)"],
    })
    expect(result.metadata.source).toBe("coingecko")
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("returns null fields when fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await tool.execute({ coingeckoId: "nonexistent" })

    expect(result.success).toBe(false)
    expect(result.error).toContain("No data")
  })

  it("returns null description when not available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: "Bitcoin",
        description: {},
        links: {},
        categories: [],
      }),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data.description).toBeNull()
  })
})

describe("get_tokenomics", () => {
  const tool = coingeckoMetadataTools.find((t) => t.name === "get_tokenomics")!

  it("returns supply data and unlock events", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market_data: {
            circulating_supply: 19000000,
            total_supply: 21000000,
            max_supply: 21000000,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { date: "2024-01-15", amount: 500000, source: "Team" },
          { date: "2024-06-15", amount: 500000, source: "Investors" },
        ],
      })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      circulatingSupply: 19000000,
      totalSupply: 21000000,
      maxSupply: 21000000,
    })
    expect(result.data.unlockEvents).toHaveLength(2)
    expect(result.data.unlockEvents[0].source).toBe("Team")
  })

  it("handles missing market_data gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data.circulatingSupply).toBeNull()
    expect(result.data.totalSupply).toBeNull()
  })

  it("returns unlockEvents as empty array when PublicDrop fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          market_data: { circulating_supply: 19000000, total_supply: 21000000, max_supply: 21000000 },
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data.unlockEvents).toEqual([])
  })
})

describe("get_ath", () => {
  const tool = coingeckoMetadataTools.find((t) => t.name === "get_ath")!

  it("returns ATH data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        market_data: {
          ath: { usd: 69000 },
          ath_change_percentage: { usd: -50.5 },
          ath_date: { usd: "2021-11-10T00:00:00Z" },
        },
      }),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      athUsd: 69000,
      athChangePercent: -50.5,
      athDate: "2021-11-10T00:00:00Z",
    })
  })

  it("handles missing market_data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data.athUsd).toBeNull()
    expect(result.data.athChangePercent).toBeNull()
    expect(result.data.athDate).toBeNull()
  })
})

describe("get_developer_activity", () => {
  const tool = coingeckoMetadataTools.find((t) => t.name === "get_developer_activity")!

  it("returns developer activity data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        developer_data: {
          forks: 35000,
          stars: 75000,
          subscribers: 5000,
          total_issues: 500,
          closed_issues: 450,
          pull_requests_merged: 1000,
          commit_count_4_weeks: 120,
        },
      }),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      forks: 35000,
      stars: 75000,
      subscribers: 5000,
      totalIssues: 500,
      closedIssues: 450,
      pullRequestsMerged: 1000,
      commitCount4Weeks: 120,
    })
  })

  it("handles missing developer_data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(true)
    expect(result.data.forks).toBeNull()
    expect(result.data.stars).toBeNull()
  })

  it("returns error when API fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"))

    const result = await tool.execute({ coingeckoId: "bitcoin" })

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe("tool definitions", () => {
  it("exports an array of 4 tool definitions", () => {
    expect(coingeckoMetadataTools).toHaveLength(4)
  })

  it("each tool has name, description, parameters, execute", () => {
    for (const tool of coingeckoMetadataTools) {
      expect(tool.name).toBeDefined()
      expect(tool.description).toBeDefined()
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe("function")
    }
  })
})
