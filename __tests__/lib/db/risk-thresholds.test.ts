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

    expect(result.confidence_threshold).toBe(70)
    expect(result.max_position_usdc).toBe(100)
    expect(result.max_leverage).toBe(10)
    expect(result.risk_per_trade_percent).toBe(1)
  })

  it("returns document values when found", async () => {
    const { getDb } = await import("@/lib/db/arango-client")
    vi.mocked(getDb).mockReturnValue(mockDatabaseInstance as never)

    const mockCursor = { next: vi.fn().mockResolvedValue({
      userId: "user-1",
      confidence_threshold: 85,
      max_position_usdc: 500,
      max_leverage: 5,
      risk_per_trade_percent: 2,
    })}
    mockDatabaseInstance.query.mockResolvedValue(mockCursor)

    const { getRiskThresholds } = await import("@/lib/db/risk-thresholds")
    const result = await getRiskThresholds("user-1")

    expect(result.confidence_threshold).toBe(85)
    expect(result.max_position_usdc).toBe(500)
    expect(result.max_leverage).toBe(5)
    expect(result.risk_per_trade_percent).toBe(2)
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

    expect(result.confidence_threshold).toBe(70)
  })
})
