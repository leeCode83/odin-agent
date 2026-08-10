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
    const results = await queryGraphPatterns("BTC", ["RSI > 60"])

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
    const results = await queryGraphPatterns("BTC", [])

    expect(results).toEqual([])
  })

  it("returns empty array on query error", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockRejectedValue(new Error("db error"))

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    const results = await queryGraphPatterns("ETH", ["volume spike"])

    expect(results).toEqual([])
  })

  it("uses correct bind variables in AQL query", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    await queryGraphPatterns("SOL", ["breakout"])

    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR d IN"),
      expect.objectContaining({
        asset: "SOL",
        signals: ["breakout"],
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

describe("queryPerspectivePerformance", () => {
  const breakdownDecision = (perspectiveBreakdown: unknown, side: "long" | "short") => ({
    userId: "user-1",
    side,
    timestamp: "2026-08-01T00:00:00.000Z",
    perspectiveBreakdown,
  })

  it("returns null when ArangoDB is unavailable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(null)

    const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
    const result = await queryPerspectivePerformance("user-1")

    expect(result).toBeNull()
  })

  it("returns null and warns when the query throws", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockRejectedValue(new Error("db error"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
      const result = await queryPerspectivePerformance("user-1")

      expect(result).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("counts each perspective against the realized side of a profit decision", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([
      {
        decision: breakdownDecision(
          [
            { perspective: "conservative", side: "short" },
            { perspective: "balance", side: "no_trade" },
            { perspective: "aggressive", side: "short" },
          ],
          "short"
        ),
        outcome: { result: "profit" },
      },
    ])

    const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
    const result = await queryPerspectivePerformance("user-1")

    expect(result).toEqual({
      conservative: { correct: 1, total: 1 },
      balance: { correct: 0, total: 0 },
      aggressive: { correct: 1, total: 1 },
    })
  })

  it("credits a perspective that sided against a losing decision", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([
      {
        decision: breakdownDecision([{ perspective: "aggressive", side: "short" }], "long"),
        outcome: { result: "loss" },
      },
    ])

    const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
    const result = await queryPerspectivePerformance("user-1")

    expect(result).toEqual({
      conservative: { correct: 0, total: 0 },
      balance: { correct: 0, total: 0 },
      aggressive: { correct: 1, total: 1 },
    })
  })

  it("returns {} when no eligible decisions exist", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
    const result = await queryPerspectivePerformance("user-1")

    expect(result).toEqual({})
  })

  it("passes the limit as a bind variable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { queryPerspectivePerformance } = await import("@/lib/db/graph-memory")
    await queryPerspectivePerformance("user-1")

    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT @limit"),
      expect.objectContaining({ limit: 20 })
    )
  })
})

describe("recordDecision", () => {
  it("persists perspectiveBreakdown when provided", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)
    const save = vi.fn().mockResolvedValue({ _key: "dec-1" })
    mockDatabaseInstance.collection.mockReturnValue({ save })

    const { recordDecision } = await import("@/lib/db/graph-memory")
    const breakdown = [{ perspective: "conservative", side: "short" }]
    const key = await recordDecision({
      userId: "user-1",
      asset: "BTC",
      category: "trade",
      decision: "sell",
      side: "short",
      confidence: 70,
      tradePlan: {},
      autonomyDecision: "auto",
      timestamp: "2026-08-01T00:00:00.000Z",
      perspectiveBreakdown: breakdown,
    })

    expect(key).toBe("dec-1")
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ perspectiveBreakdown: breakdown }))
  })
})
