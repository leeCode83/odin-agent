/**
 * @file deterministic-confidence.test.ts
 * @description Tests for the deterministic confidence module: per-breakdown
 *   sub-scores (factor_alignment, historical_match, signal_strength) and the
 *   blended overall score. Pure-data inputs only — no LLM, no IO.
 */

import { describe, it, expect } from "vitest"
import {
  deterministicConfidence,
  factorAlignmentScore,
  historicalMatchScore,
  signalStrengthScore,
} from "@/lib/agent/shared/deterministic-confidence"

describe("factorAlignmentScore", () => {
  it("percentage of bullish factor scores aligned with long", () => {
    expect(factorAlignmentScore([{ score: 90 }, { score: 80 }], "long")).toBe(100)
  })

  it("bearish factor scores align with short", () => {
    expect(factorAlignmentScore([{ score: 30 }, { score: 20 }], "short")).toBe(100)
  })

  it("null factor score counts as non-aligned (conservative)", () => {
    expect(factorAlignmentScore([{ score: null }, { score: 90 }], "long")).toBe(50)
  })

  it("explicit direction overrides the score midpoint", () => {
    expect(factorAlignmentScore([{ score: 90, direction: "bearish" }], "long")).toBe(0)
    expect(factorAlignmentScore([{ score: 40, direction: "bullish" }], "long")).toBe(100)
  })

  it("score at midpoint 50 is neutral and never aligns", () => {
    expect(factorAlignmentScore([{ score: 50 }], "long")).toBe(0)
  })

  it("empty input → 0 (no alignment evidence)", () => {
    expect(factorAlignmentScore([], "long")).toBe(0)
  })

  it("no_trade side never aligns", () => {
    expect(factorAlignmentScore([{ score: 90 }], "no_trade")).toBe(0)
  })
})

describe("historicalMatchScore", () => {
  it("ratio of aligned to total patterns × 100", () => {
    expect(historicalMatchScore({ alignedCount: 2, totalCount: 4 })).toBe(50)
  })

  it("no data → conservative low default 30", () => {
    expect(historicalMatchScore({ alignedCount: 0, totalCount: 0 })).toBe(30)
  })

  it("zero aligned → 0", () => {
    expect(historicalMatchScore({ alignedCount: 0, totalCount: 3 })).toBe(0)
  })

  it("clamps aligned ratio above 100", () => {
    expect(historicalMatchScore({ alignedCount: 5, totalCount: 3 })).toBe(100)
  })
})

describe("signalStrengthScore", () => {
  it("mean strength of aligned signals (no votes → no boost)", () => {
    expect(
      signalStrengthScore([{ direction: "bullish", strength: 90 }, { direction: "bullish", strength: 80 }], "long", []),
    ).toBe(85)
  })

  it("full same-side agreement boosts ×1.5", () => {
    expect(
      signalStrengthScore([{ direction: "bullish", strength: 60 }, { direction: "bullish", strength: 60 }], "long", [
        "long",
        "long",
      ]),
    ).toBe(90)
  })

  it("no same-side agreement → no boost", () => {
    expect(signalStrengthScore([{ direction: "bullish", strength: 60 }], "long", ["short", "short"])).toBe(60)
  })

  it("partial agreement boosts proportionally", () => {
    expect(signalStrengthScore([{ direction: "bullish", strength: 60 }], "long", ["long", "short"])).toBe(75)
  })

  it("neutral signals contribute zero", () => {
    expect(signalStrengthScore([{ direction: "neutral", strength: 80 }], "long", ["long"])).toBe(0)
  })

  it("no signals → 0", () => {
    expect(signalStrengthScore([], "long", ["long"])).toBe(0)
  })

  it("clamps at 100 ceiling", () => {
    expect(signalStrengthScore([{ direction: "bullish", strength: 100 }], "long", ["long", "long"])).toBe(100)
  })
})

describe("deterministicConfidence", () => {
  it("full agreement across all three factors → score 100", () => {
    const result = deterministicConfidence({
      side: "long",
      factorScores: [{ score: 90 }, { score: 85 }],
      historicalMatches: { alignedCount: 3, totalCount: 3 },
      signals: [
        { direction: "bullish", strength: 90 },
        { direction: "bullish", strength: 80 },
      ],
      votes: ["long", "long", "long"],
    })
    expect(result.score).toBe(100)
    expect(result.breakdown).toEqual({ factor_alignment: 100, historical_match: 100, signal_strength: 100 })
  })

  it("total disagreement across all three factors → score 0", () => {
    const result = deterministicConfidence({
      side: "long",
      factorScores: [{ score: 30 }, { score: 40 }],
      historicalMatches: { alignedCount: 0, totalCount: 3 },
      signals: [{ direction: "bearish", strength: 90 }],
      votes: ["short", "short", "short"],
    })
    expect(result.score).toBe(0)
    expect(result.breakdown).toEqual({ factor_alignment: 0, historical_match: 0, signal_strength: 0 })
  })

  it("empty inputs → conservative low score, no crash", () => {
    const result = deterministicConfidence({
      side: "long",
      factorScores: [],
      historicalMatches: { alignedCount: 0, totalCount: 0 },
      signals: [],
      votes: [],
    })
    expect(result.score).toBe(10)
    expect(result.breakdown.factor_alignment).toBe(0)
    expect(result.breakdown.historical_match).toBe(30)
    expect(result.breakdown.signal_strength).toBe(0)
  })

  it("neutral signals keep factor/historical but zero signal_strength", () => {
    const result = deterministicConfidence({
      side: "long",
      factorScores: [{ score: 90 }, { score: 85 }],
      historicalMatches: { alignedCount: 3, totalCount: 3 },
      signals: [{ direction: "neutral", strength: 80 }],
      votes: ["long", "long"],
    })
    expect(result.score).toBe(67)
    expect(result.breakdown.signal_strength).toBe(0)
  })

  it("mixed inputs → proportional breakdown, blended score", () => {
    const result = deterministicConfidence({
      side: "long",
      factorScores: [{ score: 90 }, { score: null }],
      historicalMatches: { alignedCount: 1, totalCount: 4 },
      signals: [{ direction: "bullish", strength: 66 }],
      votes: ["long", "short", "short"],
    })
    expect(result.breakdown).toEqual({ factor_alignment: 50, historical_match: 25, signal_strength: 77 })
    expect(result.score).toBe(51)
  })

  it("breakdown fields always integers in [0,100]", () => {
    const result = deterministicConfidence({
      side: "short",
      factorScores: [{ score: 10 }, { score: 20 }, { score: 30 }],
      historicalMatches: { alignedCount: 2, totalCount: 7 },
      signals: [{ direction: "bearish", strength: 73 }],
      votes: ["short", "short", "long"],
    })
    for (const value of Object.values(result.breakdown)) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })
})
