import { describe, it, expect } from "vitest"
import { extractDegradedFactors, normalizeSignal } from "@/lib/agent/shared/dd-utils"

describe("extractDegradedFactors", () => {
  describe("array input", () => {
    it("returns empty array when all scores are valid numbers", () => {
      const reports = [
        { factor: "momentum", score: 75 },
        { factor: "volume", score: 40 },
      ]
      expect(extractDegradedFactors(reports)).toEqual([])
    })

    it("returns factor name when score is null", () => {
      const reports = [
        { factor: "momentum", score: 75 },
        { factor: "volume", score: null },
      ]
      expect(extractDegradedFactors(reports)).toEqual(["volume"])
    })

    it("returns factor name when score is undefined", () => {
      const reports = [{ factor: "momentum", score: undefined }]
      expect(extractDegradedFactors(reports)).toEqual(["momentum"])
    })

    it("returns factor name when score is not a number", () => {
      const reports = [{ factor: "momentum", score: "invalid" as unknown as number }]
      expect(extractDegradedFactors(reports)).toEqual(["momentum"])
    })

    it("returns empty array for empty input", () => {
      expect(extractDegradedFactors([])).toEqual([])
    })

    it("returns empty array when factor field is missing", () => {
      const reports = [{ score: null }]
      expect(extractDegradedFactors(reports)).toEqual([])
    })
  })

  describe("record input", () => {
    it("returns empty object when all scores are valid", () => {
      const reports = {
        momentum: { factor: "momentum", score: 75 },
        volume: { factor: "volume", score: 40 },
      }
      expect(extractDegradedFactors(reports)).toEqual([])
    })

    it("returns empty array when value is null (no factor name)", () => {
      const reports = {
        momentum: { factor: "momentum", score: 75 },
        volume: null,
      }
      expect(extractDegradedFactors(reports)).toEqual([])
    })

    it("returns factor name when score is null", () => {
      const reports = {
        momentum: { factor: "momentum", score: null },
      }
      expect(extractDegradedFactors(reports)).toEqual(["momentum"])
    })

    it("returns empty array for empty object", () => {
      expect(extractDegradedFactors({})).toEqual([])
    })
  })
})

describe("normalizeSignal", () => {
  it("converts string to SignalEntry with defaults", () => {
    expect(normalizeSignal("RSI oversold")).toEqual({
      name: "RSI oversold",
      strength: 50,
      direction: "neutral",
    })
  })

  it("fills missing fields in partial object", () => {
    expect(normalizeSignal({ name: "MACD crossover" })).toEqual({
      name: "MACD crossover",
      strength: 50,
      direction: "neutral",
    })
  })

  it("preserves all fields in full object", () => {
    expect(
      normalizeSignal({ name: "Volume spike", strength: 80, direction: "bullish" }),
    ).toEqual({
      name: "Volume spike",
      strength: 80,
      direction: "bullish",
    })
  })

  it("defaults name to unknown when missing", () => {
    expect(normalizeSignal({ strength: 90 })).toEqual({
      name: "unknown",
      strength: 90,
      direction: "neutral",
    })
  })
})
