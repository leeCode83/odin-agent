/**
 * @file graph-memory.test.ts
 * @description Tests for ArangoDB graph memory queries and DD report caching.
 * @module tests/lib/db
 * @layer test
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockDatabaseInstance, mockCursor } = vi.hoisted(() => ({
  mockDatabaseInstance: {
    collection: vi.fn(),
    query: vi.fn(),
  },
  mockCursor: {
    all: vi.fn(),
    next: vi.fn(),
  },
}))

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

vi.mock("arangojs", () => ({
  Database: vi.fn().mockImplementation(() => mockDatabaseInstance),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe("queryGraphPatterns", () => {
  it("returns patterns from AQL query", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([
      { pattern: "BTC_spot", outcome: "profit", frequency: 3 },
      { pattern: "BTC_spot", outcome: "loss", frequency: 1 },
    ])

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    const results = await queryGraphPatterns("BTC", "spot", ["RSI > 60"])

    expect(results).toHaveLength(2)
    expect(results[0].pattern).toBe("BTC_spot")
    expect(results[0].outcome).toBe("profit")
    expect(results[0].frequency).toBe(3)
    expect(mockDatabaseInstance.query).toHaveBeenCalled()
  })

  it("returns empty array when ArangoDB is unavailable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(null)

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    const results = await queryGraphPatterns("BTC", "spot", [])

    expect(results).toEqual([])
  })

  it("returns empty array on query error", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockRejectedValue(new Error("db error"))

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    const results = await queryGraphPatterns("ETH", "defi", ["volume spike"])

    expect(results).toEqual([])
  })

  it("uses correct bind variables in AQL query", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    await queryGraphPatterns("SOL", "defi", ["breakout"])

    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR d IN"),
      expect.objectContaining({
        asset: "SOL",
        category: "defi",
      })
    )
  })
})

describe("readRecentDDReport", () => {
  const validReport = {
    asset: "ETH",
    category: "ethereum",
    timestamp: new Date().toISOString(),
    sections: {
      technical: { score: 70, summary: "bullish setup", signals: ["RSI > 60"] },
      onchain: { score: null, summary: null, signals: [] },
      sentiment: { score: null, summary: null, signals: [] },
      fundamental: { score: null, summary: null, signals: [] },
    },
    risk_flags: [],
  }

  it("returns the parsed DD report when a fresh cached record exists", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([validReport])

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("ETH", "user-1")

    expect(result).toEqual(validReport)
    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR doc IN dd_reports"),
      expect.objectContaining({
        asset: "ETH",
        userId: "user-1",
        cutoff: expect.any(String),
      })
    )
  })

  it("returns null when the only cached record is stale", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("ETH", "user-1")

    expect(result).toBeNull()
  })

  it("returns null when ArangoDB is unavailable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(null)

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("ETH", "user-1")

    expect(result).toBeNull()
  })

  it("returns null when no record matches the asset and user", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("BTC", "user-other")

    expect(result).toBeNull()
  })

  it("returns null when the query throws", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockRejectedValue(new Error("db error"))

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("ETH", "user-1")

    expect(result).toBeNull()
  })

  it("returns null when the cached payload fails schema validation", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([{ asset: "ETH" }])

    const { readRecentDDReport } = await import("@/lib/db/graph-memory")
    const result = await readRecentDDReport("ETH", "user-1")

    expect(result).toBeNull()
  })
})
