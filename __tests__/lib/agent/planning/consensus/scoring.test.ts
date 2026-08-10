/**
 * @file scoring.test.ts
 * @description Tests for Layer 2 weighted consensus scoring: weighted per-side
 *   sums, the confidence fallback chain, the entry-price agreement multiplier,
 *   and agreement-boosted scores.
 */

import { describe, it, expect } from "vitest"
import {
  computeSideScores,
  agreementMultiplier,
  computeAgreementBoostedScores,
} from "@/lib/agent/planning/consensus/scoring"
import type { PerspectiveReport, PerspectiveWeights } from "@/lib/agent/planning/types"

/**
 * @function makeReport
 * @description Builds a minimal valid PerspectiveReport with test overrides.
 * @param {Partial<PerspectiveReport>} overrides - Fields to override defaults.
 * @returns {PerspectiveReport} A report with sensible defaults (score 70,
 *   confidence 70, side "long", entry 100).
 */
function makeReport(overrides: Partial<PerspectiveReport>): PerspectiveReport {
  return {
    perspective: "balance",
    score: 70,
    confidence: 70,
    side: "long",
    entry_price: 100,
    signals: [],
    dataSources: [],
    reasoning: "",
    iterations: 1,
    conclusion: "",
    errors: [],
    suggested_stop_loss: 95,
    suggested_take_profit: 115,
    suggested_position_size_usdc: 1000,
    risk_flags: [],
    ...overrides,
  } as PerspectiveReport
}

const WEIGHTS: PerspectiveWeights = { conservative: 0.2, balance: 0.3, aggressive: 0.5 }

describe("computeSideScores", () => {
  it("weighted sum per side — 2 long, 1 short, non-uniform weights (exact arithmetic)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 80 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 60 }),
      makeReport({ perspective: "balance", side: "short", confidence: 90 }),
    ]

    const scores = computeSideScores(reports, WEIGHTS)

    // long = 0.2×80 + 0.5×60 = 16 + 30 = 46; short = 0.3×90 = 27
    expect(scores.long).toBe(46)
    expect(scores.short).toBe(27)
    expect(scores.no_trade).toBe(0)
  })

  it("conf fallback chain — confidence null, score 85 → 85 used", () => {
    const reports = [
      makeReport({ perspective: "aggressive", side: "long", confidence: null, score: 85 }),
    ]

    const scores = computeSideScores(reports, WEIGHTS)

    expect(scores.long).toBe(0.5 * 85)
  })

  it("conf fallback chain — both null → 0", () => {
    const reports = [
      makeReport({ perspective: "aggressive", side: "long", confidence: null, score: null }),
    ]

    const scores = computeSideScores(reports, WEIGHTS)

    expect(scores.long).toBe(0)
  })

  it("no_trade reports contribute to the no_trade score", () => {
    const reports = [
      makeReport({ perspective: "balance", side: "no_trade", confidence: 70 }),
    ]

    const scores = computeSideScores(reports, WEIGHTS)

    expect(scores.no_trade).toBe(0.3 * 70)
    expect(scores.long).toBe(0)
    expect(scores.short).toBe(0)
  })

  it("all three keys present, default 0 on empty input", () => {
    const scores = computeSideScores([], WEIGHTS)

    expect(scores).toEqual({ long: 0, short: 0, no_trade: 0 })
  })

  it("pure — input reports not mutated", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 80 }),
    ]
    const snapshot = reports.map((r) => ({ ...r }))

    computeSideScores(reports, WEIGHTS)

    expect(reports).toEqual(snapshot)
  })
})

describe("agreementMultiplier", () => {
  it("0 reports on side → 1", () => {
    const reports = [makeReport({ side: "short", entry_price: 100 })]

    expect(agreementMultiplier(reports, "long")).toBe(1)
  })

  it("1 report on side → 1 (no agreement signal)", () => {
    const reports = [makeReport({ side: "long", entry_price: 100 })]

    expect(agreementMultiplier(reports, "long")).toBe(1)
  })

  it("relative spread ≥ 5% → 1", () => {
    const reports = [
      makeReport({ side: "long", entry_price: 95 }),
      makeReport({ side: "long", entry_price: 100 }),
    ]

    // spread = 5 / 97.5 ≈ 0.0513 ≥ 0.05
    expect(agreementMultiplier(reports, "long")).toBe(1)
  })

  it("relative spread < 5% → 1.1", () => {
    const reports = [
      makeReport({ side: "long", entry_price: 98 }),
      makeReport({ side: "long", entry_price: 100 }),
      makeReport({ side: "long", entry_price: 99 }),
    ]

    // spread = 2 / 99 ≈ 0.0202 < 0.05
    expect(agreementMultiplier(reports, "long")).toBe(1.1)
  })

  it("reports with entry_price ≤ 0 excluded from agreement", () => {
    const reports = [
      makeReport({ side: "long", entry_price: 100 }),
      makeReport({ side: "long", entry_price: 0 }),
    ]

    // only 1 valid entry → falls back to no-agreement
    expect(agreementMultiplier(reports, "long")).toBe(1)
  })

  it("other-side reports never counted", () => {
    const reports = [
      makeReport({ side: "long", entry_price: 98 }),
      makeReport({ side: "long", entry_price: 100 }),
      makeReport({ side: "short", entry_price: 99 }),
    ]

    expect(agreementMultiplier(reports, "long")).toBe(1.1)
    expect(agreementMultiplier(reports, "short")).toBe(1)
  })
})

describe("computeAgreementBoostedScores", () => {
  it("boost applied to long only when its reports agree", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 80, entry_price: 98 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 60, entry_price: 100 }),
      makeReport({ perspective: "balance", side: "short", confidence: 90, entry_price: 99 }),
    ]

    const scores = computeAgreementBoostedScores(reports, WEIGHTS)

    // long = 46 × 1.1 = 50.6 (2 agreeing entries); short = 27 (single report, no boost)
    expect(scores.long).toBe(50.6)
    expect(scores.short).toBe(27)
  })

  it("no boost when long reports disagree — score equals plain weighted sum", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 80, entry_price: 95 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 60, entry_price: 100 }),
    ]

    const scores = computeAgreementBoostedScores(reports, WEIGHTS)

    // spread ≈ 0.0513 ≥ 0.05 → multiplier 1 → long stays 46
    expect(scores.long).toBe(46)
  })

  it("no_trade score never boosted", () => {
    const reports = [
      makeReport({ perspective: "balance", side: "no_trade", confidence: 70 }),
    ]

    const scores = computeAgreementBoostedScores(reports, WEIGHTS)

    expect(scores.no_trade).toBe(0.3 * 70)
  })

  it("rounds boosted scores to 2 decimals", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 33, entry_price: 100 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 33, entry_price: 100 }),
    ]

    const scores = computeAgreementBoostedScores(reports, WEIGHTS)

    // 0.2×33 + 0.5×33 = 23.1; ×1.1 = 25.410000000000004 → 25.41
    expect(scores.long).toBe(25.41)
  })

  it("returns a fresh object — mutation of one result never leaks", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long", confidence: 80, entry_price: 98 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 60, entry_price: 100 }),
    ]

    const first = computeAgreementBoostedScores(reports, WEIGHTS)
    first.long = 999
    const second = computeAgreementBoostedScores(reports, WEIGHTS)

    expect(second.long).toBe(50.6)
  })
})
