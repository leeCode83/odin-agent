import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { publicDropTools } from "@/lib/agent/due-diligence/tools/fundamental/publicdrop"

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("get_unlock_events", () => {
  const tool = publicDropTools.find((t) => t.name === "get_unlock_events")!

  it("returns unlock events for an asset", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { date: "2024-01-15T00:00:00Z", amount: 500000, value_usd: 5000000, source: "Team" },
        { date: "2024-06-15T00:00:00Z", amount: 1000000, value_usd: 10000000, source: "Investors" },
      ],
    })

    const result = await tool.execute({ asset: "BTC" })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.data[0].source).toBe("Team")
    expect(result.data[0].amount).toBe(500000)
    expect(result.metadata.source).toBe("publicdrop")
  })

  it("returns empty array when API returns non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

    const result = await tool.execute({ asset: "UNKNOWN" })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })

  it("handles network errors by returning empty array", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"))

    const result = await tool.execute({ asset: "BTC" })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })
})

describe("get_inflation_data", () => {
  const tool = publicDropTools.find((t) => t.name === "get_inflation_data")!

  it("returns inflation data for an asset", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        current_rate_percent: 1.75,
        next_rate_change_date: "2024-06-01T00:00:00Z",
        next_rate_percent: 1.5,
        historical: [
          { date: "2023-01-01", rate_percent: 2.0 },
          { date: "2024-01-01", rate_percent: 1.75 },
        ],
      }),
    })

    const result = await tool.execute({ asset: "BTC" })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      currentRatePercent: 1.75,
      nextRateChangeDate: "2024-06-01T00:00:00Z",
      nextRatePercent: 1.5,
    })
    expect(result.data.historical).toHaveLength(2)
  })

  it("returns error when API fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const result = await tool.execute({ asset: "BTC" })

    expect(result.success).toBe(false)
    expect(result.error).toContain("inflation data")
  })

  it("handles partial response gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ current_rate_percent: 1.75 }),
    })

    const result = await tool.execute({ asset: "BTC" })

    expect(result.success).toBe(true)
    expect(result.data.currentRatePercent).toBe(1.75)
    expect(result.data.nextRateChangeDate).toBeNull()
    expect(result.data.historical).toEqual([])
  })
})

describe("tool definitions", () => {
  it("exports an array of 2 tool definitions", () => {
    expect(publicDropTools).toHaveLength(2)
  })

  it("each tool has name, description, parameters, execute", () => {
    for (const tool of publicDropTools) {
      expect(tool.name).toBeDefined()
      expect(tool.description).toBeDefined()
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe("function")
    }
  })
})
