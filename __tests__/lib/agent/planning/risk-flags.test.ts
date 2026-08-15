/**
 * @file risk-flags.test.ts
 * @description Tests for the structured RiskFlag enum and merge helper
 * (lib/agent/shared/risk-flags.ts). Asserts the exact P4 SA2 PHASE 0 CONTRACT
 * string values, schema validation, and merge/dedupe behavior.
 */

import { describe, it, expect } from "vitest"
import {
  RISK_FLAG_VALUES,
  RiskFlag,
  RiskFlagSchema,
  mergeRiskFlags,
} from "@/lib/agent/shared/risk-flags"

describe("RiskFlag enum", () => {
  it("exposes the exact PHASE 0 CONTRACT string values", () => {
    expect(RISK_FLAG_VALUES).toEqual([
      "funding_overheated",
      "oi_divergence",
      "liquidation_zone_proximity",
      "cascade_risk",
      "low_liquidity",
      "insufficient_data",
    ])
  })

  it("provides enum-style value access per flag", () => {
    expect(RiskFlag.funding_overheated).toBe("funding_overheated")
    expect(RiskFlag.oi_divergence).toBe("oi_divergence")
    expect(RiskFlag.liquidation_zone_proximity).toBe("liquidation_zone_proximity")
    expect(RiskFlag.cascade_risk).toBe("cascade_risk")
    expect(RiskFlag.low_liquidity).toBe("low_liquidity")
    expect(RiskFlag.insufficient_data).toBe("insufficient_data")
  })
})

describe("RiskFlagSchema", () => {
  it("parses every enum value", () => {
    for (const value of RISK_FLAG_VALUES) {
      expect(RiskFlagSchema.parse(value)).toBe(value)
    }
  })

  it("rejects free-form LLM prose and non-strings", () => {
    expect(RiskFlagSchema.safeParse("funding overheat").success).toBe(false)
    expect(RiskFlagSchema.safeParse("Funding_rate_extreme").success).toBe(false)
    expect(RiskFlagSchema.safeParse("funding").success).toBe(false)
    expect(RiskFlagSchema.safeParse(42).success).toBe(false)
    expect(RiskFlagSchema.safeParse(null).success).toBe(false)
  })
})

describe("mergeRiskFlags", () => {
  it("returns [] for empty input", () => {
    expect(mergeRiskFlags([])).toEqual([])
    expect(mergeRiskFlags([[], [], []])).toEqual([])
  })

  it("passes a single group through unchanged (enum values only)", () => {
    expect(mergeRiskFlags([[RiskFlag.funding_overheated]])).toEqual([
      "funding_overheated",
    ])
  })

  it("merges flags across reports and dedupes, first-seen order", () => {
    const merged = mergeRiskFlags([
      [RiskFlag.funding_overheated, RiskFlag.oi_divergence],
      [RiskFlag.funding_overheated, RiskFlag.cascade_risk],
      [RiskFlag.low_liquidity],
    ])
    expect(merged).toEqual([
      "funding_overheated",
      "oi_divergence",
      "cascade_risk",
      "low_liquidity",
    ])
  })

  it("drops non-enum entries (LLM prose) — free text never gates", () => {
    const merged = mergeRiskFlags([
      [RiskFlag.funding_overheated, "funding overheat", "Funding_rate_extreme"],
      ["some verifier: note", "funding"],
    ])
    expect(merged).toEqual(["funding_overheated"])
  })

  it("does not mutate input arrays", () => {
    const group = [RiskFlag.cascade_risk]
    mergeRiskFlags([group])
    expect(group).toEqual([RiskFlag.cascade_risk])
  })
})
