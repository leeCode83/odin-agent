/**
 * @file weights.test.ts
 * @description Tests for the dynamic weighting layer (L1): cold-start
 *   smoothing and normalization in computePerspectiveWeights, and the
 *   selective Winner-Takes-All boost in applyWta.
 */

import { describe, it, expect } from "vitest"
import {
  computePerspectiveWeights,
  applyWta,
  DEFAULT_WEIGHT_CONFIG,
} from "@/lib/agent/planning/consensus/weights"
import type {
  Perspective,
  PerspectivePerformance,
  PerspectiveWeights,
} from "@/lib/agent/planning/types"

const ALL_TOTAL_10_PERF: Record<Perspective, PerspectivePerformance> = {
  conservative: { correct: 8, total: 10 },
  balance: { correct: 5, total: 10 },
  aggressive: { correct: 4, total: 10 },
}

describe("computePerspectiveWeights", () => {
  it("null perf (cold-start / DB unavailable) → uniform, each exactly 1/3", () => {
    const w = computePerspectiveWeights(null, DEFAULT_WEIGHT_CONFIG)

    expect(w).toEqual({ conservative: 1 / 3, balance: 1 / 3, aggressive: 1 / 3 })
  })

  it("small history (t=1, λ=20 → α ≈ 0.04877057549928659) → weights close to uniform", () => {
    const alpha = 1 - Math.exp(-1 / DEFAULT_WEIGHT_CONFIG.coldStartLambda)
    expect(alpha).toBeCloseTo(0.04877057549928659, 12)

    const w = computePerspectiveWeights(
      {
        conservative: { correct: 1, total: 1 },
        balance: { correct: 0, total: 1 },
        aggressive: { correct: 0, total: 1 },
      },
      DEFAULT_WEIGHT_CONFIG
    )

    // weight_i = α·winRate_i + (1−α)·(1/3), normalized (Σ = 1 exactly here)
    const baseline = (1 - alpha) / 3
    expect(w.conservative).toBeCloseTo(alpha + baseline, 9)
    expect(w.balance).toBeCloseTo(baseline, 9)
    expect(w.aggressive).toBeCloseTo(baseline, 9)
    expect(w.conservative).toBeCloseTo(1 / 3, 1)
    expect(w.balance).toBeCloseTo(1 / 3, 1)
  })

  it("20 samples, aggressive always right → aggressive weight highest, Σ = 1", () => {
    const w = computePerspectiveWeights(
      {
        conservative: { correct: 10, total: 20 },
        balance: { correct: 10, total: 20 },
        aggressive: { correct: 20, total: 20 },
      },
      DEFAULT_WEIGHT_CONFIG
    )

    // α = 1 − e^(−20/20) = 1 − e^(−1) ≈ 0.6321; raw blend normalized by its sum
    const alpha = 1 - Math.exp(-20 / DEFAULT_WEIGHT_CONFIG.coldStartLambda)
    const rawAggressive = alpha * 1 + (1 - alpha) / 3
    const rawConservative = alpha * 0.5 + (1 - alpha) / 3
    const sum = rawAggressive + 2 * rawConservative

    expect(w.aggressive).toBeCloseTo(rawAggressive / sum, 9)
    expect(w.conservative).toBeCloseTo(rawConservative / sum, 9)
    expect(w.balance).toBeCloseTo(rawConservative / sum, 9)
    expect(w.aggressive).toBeGreaterThan(w.conservative)
    expect(w.aggressive).toBeGreaterThan(w.balance)
    expect(w.conservative + w.balance + w.aggressive).toBeCloseTo(1, 9)
  })

  it("perspective with total=0 → t=0 gates the blend → uniform (1/3 baseline)", () => {
    const w = computePerspectiveWeights(
      {
        conservative: { correct: 5, total: 5 },
        balance: { correct: 5, total: 5 },
        aggressive: { correct: 0, total: 0 },
      },
      DEFAULT_WEIGHT_CONFIG
    )

    // reason: t = min over totals = 0 → α = 0 → every perspective sits at the
    // 1/3 baseline; the zero-sample perspective can never drag weights up.
    expect(w).toEqual({ conservative: 1 / 3, balance: 1 / 3, aggressive: 1 / 3 })
  })

  it("empty record {} (no rows in graph memory) → uniform, no crash", () => {
    // reason: the DB layer returns {} when the user has no decisions with a
    // perspectiveBreakdown — regression case for the production 500.
    const w = computePerspectiveWeights({}, DEFAULT_WEIGHT_CONFIG)

    expect(w).toEqual({ conservative: 1 / 3, balance: 1 / 3, aggressive: 1 / 3 })
  })

  it("partial record (one perspective never traded) → no crash, missing keys baseline", () => {
    const w = computePerspectiveWeights(
      { aggressive: { correct: 9, total: 10 } },
      DEFAULT_WEIGHT_CONFIG
    )

    // reason: missing keys resolve to { correct: 0, total: 0 } → t = 0 → α = 0
    // → uniform (the absent perspectives gate trust to zero, same as total=0).
    expect(w).toEqual({ conservative: 1 / 3, balance: 1 / 3, aggressive: 1 / 3 })
  })

  it("Σ always 1 across mixed histories (perfect, failed, mixed, tiny)", () => {
    const cases: Record<Perspective, PerspectivePerformance>[] = [
      { conservative: { correct: 20, total: 20 }, balance: { correct: 20, total: 20 }, aggressive: { correct: 20, total: 20 } },
      { conservative: { correct: 0, total: 20 }, balance: { correct: 0, total: 20 }, aggressive: { correct: 0, total: 20 } },
      { conservative: { correct: 12, total: 20 }, balance: { correct: 9, total: 20 }, aggressive: { correct: 15, total: 20 } },
      { conservative: { correct: 0, total: 0 }, balance: { correct: 0, total: 0 }, aggressive: { correct: 1, total: 1 } },
    ]

    for (const perf of cases) {
      const w = computePerspectiveWeights(perf, DEFAULT_WEIGHT_CONFIG)
      expect(w.conservative + w.balance + w.aggressive).toBeCloseTo(1, 9)
    }
  })
})

describe("applyWta", () => {
  it("best below wtaMinSamples → unchanged", () => {
    const weights: PerspectiveWeights = { conservative: 0.6, balance: 0.25, aggressive: 0.15 }
    const perf: Record<Perspective, PerspectivePerformance> = {
      conservative: { correct: 2, total: 2 },
      balance: { correct: 1, total: 2 },
      aggressive: { correct: 1, total: 2 },
    }

    // conservative dominates (0.6 ≥ 3 × 0.25) but only 2 samples < 5 → no boost
    expect(applyWta(weights, perf, DEFAULT_WEIGHT_CONFIG)).toEqual(weights)
  })

  it("dominance ratio < threshold → unchanged", () => {
    const weights: PerspectiveWeights = { conservative: 0.45, balance: 0.3, aggressive: 0.25 }
    const perf: Record<Perspective, PerspectivePerformance> = {
      conservative: { correct: 5, total: 10 },
      balance: { correct: 4, total: 10 },
      aggressive: { correct: 4, total: 10 },
    }

    // 0.45 < 3 × 0.3 = 0.9 → no boost
    expect(applyWta(weights, perf, DEFAULT_WEIGHT_CONFIG)).toEqual(weights)
  })

  it("dominance ≥ threshold → best gets wtaWeight, others sum 1 − wtaWeight proportionally", () => {
    const weights: PerspectiveWeights = { conservative: 0.7, balance: 0.2, aggressive: 0.1 }

    const out = applyWta(weights, ALL_TOTAL_10_PERF, DEFAULT_WEIGHT_CONFIG)

    // 0.7 ≥ 3 × 0.2 = 0.6 → boost; remainder 0.4 split in the 0.2:0.1 ratio
    expect(out.conservative).toBe(0.6)
    expect(out.balance).toBeCloseTo(0.4 * (0.2 / 0.3), 9)
    expect(out.aggressive).toBeCloseTo(0.4 * (0.1 / 0.3), 9)
    expect(out.balance + out.aggressive).toBeCloseTo(0.4, 9)
    expect(out.conservative + out.balance + out.aggressive).toBeCloseTo(1, 9)
  })

  it("dominant best with two zero-weight others → split remainder evenly", () => {
    const weights: PerspectiveWeights = { conservative: 1, balance: 0, aggressive: 0 }

    const out = applyWta(weights, ALL_TOTAL_10_PERF, DEFAULT_WEIGHT_CONFIG)

    expect(out.conservative).toBe(0.6)
    expect(out.balance).toBeCloseTo(0.2, 9)
    expect(out.aggressive).toBeCloseTo(0.2, 9)
  })

  it("null perf → unchanged", () => {
    const weights: PerspectiveWeights = { conservative: 0.6, balance: 0.25, aggressive: 0.15 }

    expect(applyWta(weights, null, DEFAULT_WEIGHT_CONFIG)).toEqual(weights)
  })

  it("empty record {} → unchanged, no crash", () => {
    const weights: PerspectiveWeights = { conservative: 0.6, balance: 0.25, aggressive: 0.15 }

    // reason: {} has no samples for any perspective → baseline total 0 <
    // wtaMinSamples → boost skipped (regression guard for the 500).
    expect(applyWta(weights, {}, DEFAULT_WEIGHT_CONFIG)).toEqual(weights)
  })

  it("partial record — best perspective missing from perf → unchanged, no crash", () => {
    const weights: PerspectiveWeights = { conservative: 0.7, balance: 0.2, aggressive: 0.1 }

    // reason: best (conservative) has no entry → baseline total 0 → boost
    // skipped even though the weights look dominant.
    const out = applyWta(
      weights,
      { balance: { correct: 5, total: 10 }, aggressive: { correct: 5, total: 10 } },
      DEFAULT_WEIGHT_CONFIG
    )

    expect(out).toEqual(weights)
  })

  it("never mutates inputs", () => {
    const weights: PerspectiveWeights = { conservative: 0.7, balance: 0.2, aggressive: 0.1 }
    const perf: Record<Perspective, PerspectivePerformance> = {
      conservative: { correct: 8, total: 10 },
      balance: { correct: 5, total: 10 },
      aggressive: { correct: 4, total: 10 },
    }
    const weightsBefore = JSON.parse(JSON.stringify(weights)) as PerspectiveWeights
    const perfBefore = JSON.parse(JSON.stringify(perf)) as Record<
      Perspective,
      PerspectivePerformance
    >

    applyWta(weights, perf, DEFAULT_WEIGHT_CONFIG)

    expect(weights).toEqual(weightsBefore)
    expect(perf).toEqual(perfBefore)
  })
})
