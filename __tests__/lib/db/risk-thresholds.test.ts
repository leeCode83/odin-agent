import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockDatabaseInstance } = vi.hoisted(() => ({
  mockDatabaseInstance: {
    query: vi.fn(),
  },
}))

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getRiskThresholds", () => {
  it("returns defaults when ArangoDB is unavailable", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(null)

    const { getRiskThresholds } = await import("@/lib/db/risk-thresholds")
    const result = await getRiskThresholds("user-1")

    expect(result.confidenceThreshold).toBe(70)
    expect(result.maxPositionUsdc).toBe(100)
    expect(result.maxLeverage).toBe(10)
    expect(result.riskPerTradePercent).toBe(1)
  })

  it("returns document values when found", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    const mockCursor = { next: vi.fn().mockResolvedValue({
      userId: "user-1",
      confidenceThreshold: 85,
      maxPositionUsdc: 500,
      maxLeverage: 5,
      riskPerTradePercent: 2,
    })}
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)

    const { getRiskThresholds } = await import("@/lib/db/risk-thresholds")
    const result = await getRiskThresholds("user-1")

    expect(result.confidenceThreshold).toBe(85)
    expect(result.maxPositionUsdc).toBe(500)
    expect(result.maxLeverage).toBe(5)
    expect(result.riskPerTradePercent).toBe(2)
    expect(mockDatabaseInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("risk_thresholds"),
      expect.objectContaining({ userId: "user-1" })
    )
  })

  it("returns defaults on query error", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    mockDatabaseInstance.query.mockRejectedValue(new Error("query failed"))

    const { getRiskThresholds } = await import("@/lib/db/risk-thresholds")
    const result = await getRiskThresholds("user-1")

    expect(result.confidenceThreshold).toBe(70)
  })
})
