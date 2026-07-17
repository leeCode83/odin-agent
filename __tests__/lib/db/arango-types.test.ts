import { describe, it, expect } from "vitest"
import { RiskThresholdsDocSchema, GraphCollectionNames } from "@/lib/db/arango-types"

describe("RiskThresholdsDocSchema", () => {
  const validDoc = {
    userId: "user-1",
    confidenceThreshold: 70,
    maxPositionUsdc: 100,
    maxLeverage: 10,
    riskPerTradePercent: 1,
  }

  it("validates complete doc", () => {
    const result = RiskThresholdsDocSchema.parse(validDoc)
    expect(result.userId).toBe("user-1")
    expect(result.confidenceThreshold).toBe(70)
  })

  it("applies defaults for optional fields", () => {
    const result = RiskThresholdsDocSchema.parse({ userId: "user-2" })
    expect(result.confidenceThreshold).toBe(70)
    expect(result.maxLeverage).toBe(10)
  })

  it("rejects confidenceThreshold outside 0-100", () => {
    expect(() => RiskThresholdsDocSchema.parse({ ...validDoc, confidenceThreshold: 200 })).toThrow()
  })

  it("accepts optional _key", () => {
    const result = RiskThresholdsDocSchema.parse({ ...validDoc, _key: "thresholds/user-1" })
    expect(result._key).toBe("thresholds/user-1")
  })
})

describe("GraphCollectionNames", () => {
  it("defines all expected collection names", () => {
    expect(GraphCollectionNames.DECISIONS).toBe("decisions")
    expect(GraphCollectionNames.SIGNALS).toBe("signals")
    expect(GraphCollectionNames.ASSETS).toBe("assets")
    expect(GraphCollectionNames.EDGE_DECISION_ANALYZED).toBe("decision_analyzed")
    expect(GraphCollectionNames.EDGE_ASSET_BELONGS_TO).toBe("asset_belongs_to")
  })
})
