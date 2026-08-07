import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/data/sentiment/altme", () => ({
  fetchFearGreedIndex: vi.fn(),
}))

import { fetchFearGreedIndex } from "@/lib/data/sentiment/altme"
import { getFearGreed } from "@/lib/agent/due-diligence/tools/sentiment/altme"

describe("get_fear_greed tool", () => {
  beforeEach(() => {
    vi.mocked(fetchFearGreedIndex).mockResolvedValue({
      value: 42,
      classification: "Fear",
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns fear & greed data on success", async () => {
    const result = await getFearGreed.execute({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ value: 42, classification: "Fear" })
    expect(result.metadata.source).toBe("altme")
  })

  it("returns error when fetchFearGreedIndex throws", async () => {
    vi.mocked(fetchFearGreedIndex).mockRejectedValue(new Error("API error"))
    const result = await getFearGreed.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })

  it("handles null data gracefully", async () => {
    vi.mocked(fetchFearGreedIndex).mockResolvedValue({
      value: null,
      classification: null,
    })
    const result = await getFearGreed.execute({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ value: null, classification: null })
  })
})
