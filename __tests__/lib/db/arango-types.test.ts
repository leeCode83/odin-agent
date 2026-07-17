import { describe, it, expect } from "vitest"
import { RiskThresholdsDocSchema, GraphCollectionNames } from "@/lib/db/arango-types"

describe("RiskThresholdsDocSchema", () => {
  const validDoc = {
    userId: "user-1",
    confidence_threshold: 70,
    max_position_usdc: 100,
    max_leverage: 10,
    risk_per_trade_percent: 1,
  }

  it("validates complete doc", () => {
    const result = RiskThresholdsDocSchema.parse(validDoc)
    expect(result.userId).toBe("user-1")
    expect(result.confidence_threshold).toBe(70)
  })

  it("applies defaults for optional fields", () => {
    const result = RiskThresholdsDocSchema.parse({ userId: "user-2" })
    expect(result.confidence_threshold).toBe(70)
    expect(result.max_leverage).toBe(10)
  })

  it("rejects confidence_threshold outside 0-100", () => {
    expect(() => RiskThresholdsDocSchema.parse({ ...validDoc, confidence_threshold: 200 })).toThrow()
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
    expect(GraphCollectionNames.EDGE_ANALYZED).toBe("decision_analyzed")
    expect(GraphCollectionNames.EDGE_ASSET_BELONGS_TO).toBe("asset_belongs_to")
  })
})
