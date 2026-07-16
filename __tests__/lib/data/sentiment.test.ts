import { describe, it, expect, vi } from "vitest"
import { fetchFearGreedIndex } from "@/lib/data/sentiment"

describe("fetchFearGreedIndex", () => {
  it("returns fear greed data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ value: "45", value_classification: "Fear", timestamp: "1710000000" }] }),
    }))
    const result = await fetchFearGreedIndex()
    expect(result).toHaveProperty("value")
    expect(result).toHaveProperty("classification")
    expect(result.value).toBe(45)
    vi.unstubAllGlobals()
  })

  it("returns null values on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")))
    const result = await fetchFearGreedIndex()
    expect(result.value).toBeNull()
    expect(result.classification).toBeNull()
    vi.unstubAllGlobals()
  })
})
