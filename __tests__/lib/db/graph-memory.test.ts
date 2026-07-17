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
    const results = await queryGraphPatterns("BTC", "spot")

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
    const results = await queryGraphPatterns("BTC", "spot")

    expect(results).toEqual([])
  })

  it("returns empty array on query error", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockRejectedValue(new Error("db error"))

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    const results = await queryGraphPatterns("ETH", "defi")

    expect(results).toEqual([])
  })

  it("uses correct bind variables in AQL query", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockResolvedValue(mockCursor)
    mockCursor.all.mockResolvedValue([])

    const { queryGraphPatterns } = await import("@/lib/db/graph-memory")
    await queryGraphPatterns("SOL", "defi")

    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR d IN"),
      expect.objectContaining({
        asset: "SOL",
        category: "defi",
      })
    )
  })
})
