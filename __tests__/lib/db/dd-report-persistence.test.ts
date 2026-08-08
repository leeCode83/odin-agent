/**
 * @file dd-report-persistence.test.ts
 * @description Tests for DD report persistence in ArangoDB and setup migration.
 * @module tests/lib/db
 * @layer test
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockDb, mockCol } = vi.hoisted(() => ({
  mockDb: { collection: vi.fn() },
  mockCol: { save: vi.fn() },
}))

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
  createArangoClient: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe("recordDDReport", () => {
  const mockReport = {
    asset: "BTC",
    category: "spot",
    confidence_score: 85,
    processingTimeMs: 1500,
  }

  it("inserts document with correct fields", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDb as never)
    mockDb.collection.mockReturnValue(mockCol)
    mockCol.save.mockResolvedValue({ _key: "test-key-123" })

    const { recordDDReport } = await import("@/lib/db/graph-memory")
    const key = await recordDDReport(
      mockReport as Record<string, unknown>,
      "user-1",
      "0x123"
    )

    expect(mockDb.collection).toHaveBeenCalledWith("dd_reports")
    expect(mockCol.save).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        userId: "user-1",
        walletAddress: "0x123",
        asset: "BTC",
        report: mockReport,
        timestamp: expect.any(String),
        processingTimeMs: 1500,
      })
    )
    expect(key).toBe("test-key-123")
  })

  it("returns _key on success", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDb as never)
    mockDb.collection.mockReturnValue(mockCol)
    mockCol.save.mockResolvedValue({ _key: "abc-123" })

    const { recordDDReport } = await import("@/lib/db/graph-memory")
    const key = await recordDDReport(
      mockReport as Record<string, unknown>,
      "user-1",
      "0x123"
    )

    expect(key).toBe("abc-123")
  })

  it("returns empty string when DB unavailable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(null)

    const { recordDDReport } = await import("@/lib/db/graph-memory")
    const key = await recordDDReport(
      mockReport as Record<string, unknown>,
      "user-1",
      "0x123"
    )

    expect(key).toBe("")
  })

  it("returns empty string on save error", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDb as never)
    mockDb.collection.mockReturnValue(mockCol)
    mockCol.save.mockRejectedValue(new Error("save failed"))

    const { recordDDReport } = await import("@/lib/db/graph-memory")
    const key = await recordDDReport(
      mockReport as Record<string, unknown>,
      "user-1",
      "0x123"
    )

    expect(key).toBe("")
  })
})

describe("setupArangoGraph", () => {
  it("processes new collections", async () => {
    const { createArangoClient } = await import("@/lib/db/arango-client")
    const mockSetupDb = {
      createCollection: vi.fn().mockResolvedValue(undefined),
      createEdgeCollection: vi.fn().mockResolvedValue(undefined),
      createGraph: vi.fn().mockResolvedValue(undefined),
    }
    vi.mocked(createArangoClient).mockReturnValue(mockSetupDb as never)

    const { setupArangoGraph } = await import("@/lib/db/setup")
    await setupArangoGraph()

    expect(mockSetupDb.createCollection).toHaveBeenCalledWith("dd_reports")
    expect(mockSetupDb.createEdgeCollection).toHaveBeenCalledWith(
      "decision_has_factorreport"
    )
    expect(mockSetupDb.createGraph).toHaveBeenCalledWith(
      "odin_graph",
      expect.arrayContaining([
        expect.objectContaining({
          collection: "decision_has_factorreport",
          from: ["decisions"],
          to: ["signals"],
        }),
      ])
    )
  })
})
