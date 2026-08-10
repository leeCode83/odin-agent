/**
 * @file override.test.ts
 * @description Tests for evaluateOverride (Layer 3 strong-minority override).
 *   Golden cases are the acceptance criteria of the consensus upgrade: rescue
 *   from a 2+ no_trade majority, never rescue unanimity or infeasible trades,
 *   deterministic confidence from L2 side scores, aggregation-free module.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { evaluateOverride } from "@/lib/agent/planning/consensus/override"
import type {
  OverrideRuleDetail,
  PerspectiveReport,
  SideScores,
} from "@/lib/agent/planning/types"

/**
 * @function makeReport
 * @description Builds a minimal valid PerspectiveReport with test overrides.
 * @param {Partial<PerspectiveReport>} overrides - Fields to override defaults.
 * @returns {PerspectiveReport} A report with sensible defaults (score 70,
 *   confidence 70, side "long", no risk flags).
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

/**
 * @function makeSideScores
 * @description Builds a full SideScores literal with test overrides.
 * @param {Partial<SideScores>} overrides - Per-side score overrides.
 * @returns {SideScores} Defaults: all sides 0.
 */
function makeSideScores(overrides: Partial<SideScores>): SideScores {
  return { long: 0, short: 0, no_trade: 0, ...overrides }
}

// caller passes the STRONG_SIGNAL_CONFIDENCE constant from evaluate.ts (= 70)
const THRESHOLD = 70

describe("evaluateOverride", () => {
  it("GOLDEN 1 — 2 no_trade + short conf 85, sideScores.short 85 → applied short 85 by aggressive", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "short", confidence: 85 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 85, no_trade: 80 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(true)
    if (result.applied) {
      expect(result.side).toBe("short")
      expect(result.confidence).toBe(85)
      expect(result.triggeredBy).toBe("aggressive")
    }
  })

  it("GOLDEN 2 — 3/3 no_trade (unanimous) → never rescued, even with high no_trade sideScore", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 85 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 85 }),
      makeReport({ perspective: "aggressive", side: "no_trade", confidence: 85 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ no_trade: 100 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(false)
  })

  it("GOLDEN 3 — strong minority conf 60 < threshold → not applied", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "short", confidence: 60 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 60 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(false)
  })

  it("GOLDEN 4 — sideScores.short 85 but every report on short conf 69 < threshold → not applied", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "short", confidence: 69 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 85 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(false)
  })

  it("GOLDEN 5 — everything qualifies but profitFeasible false → not applied", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "short", confidence: 85 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 85 }),
      false,
      THRESHOLD
    )

    expect(result.applied).toBe(false)
  })

  it("GOLDEN 6a — both sides qualify → higher sideScore wins", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 80 }),
      makeReport({ perspective: "conservative", side: "short", confidence: 80 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ long: 85, short: 90 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(true)
    if (result.applied) expect(result.side).toBe("short")
  })

  it("GOLDEN 6b — both sides qualify with equal score → tie goes long", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 80 }),
      makeReport({ perspective: "conservative", side: "short", confidence: 80 }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ long: 85, short: 85 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(true)
    if (result.applied) expect(result.side).toBe("long")
  })

  it("GOLDEN 7a — sideScores missing keys → tie-break treats them as 0, no crash", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 85 }),
    ]

    // reason: the qualify gate reads REPORT confidence, not sideScores, so a
    // malformed/partial SideScores must not block a legitimate rescue — the
    // missing short key reads as 0 and only affects the tie-break.
    const result = evaluateOverride(reports, {} as SideScores, true, THRESHOLD)

    expect(result.applied).toBe(true)
    if (result.applied) expect(result.side).toBe("long")
  })

  it("GOLDEN 7b — empty reports → not applied, no crash", () => {
    const result = evaluateOverride([], makeSideScores({ short: 85 }), true, THRESHOLD)

    expect(result.applied).toBe(false)
  })

  it("null confidence treated as 0 (report on side cannot clear threshold)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({
        perspective: "aggressive",
        side: "short",
        confidence: null,
        score: null,
      }),
    ]

    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 85 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(false)
  })

  it("GOLDEN 8 — module imports only types (aggregation-free by import graph)", () => {
    const sourcePath = fileURLToPath(
      new URL("../../../../../lib/agent/planning/consensus/override.ts", import.meta.url)
    )
    const source = readFileSync(sourcePath, "utf8")
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])

    // reason: the only allowed dependency is the type contract — any value
    // import (aggregation, weights, scoring, evaluate) would violate the
    // layer separation that keeps the override deterministic and testable.
    expect(imports.length).toBe(1)
    expect(imports[0]).toBe("@/lib/agent/planning/types")
  })

  it("confidence in result is the strongest report confidence on the side (deterministic)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "long", confidence: 85 }),
    ]

    const result: OverrideRuleDetail = evaluateOverride(
      reports,
      makeSideScores({ long: 28.33 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(true)
    if (result.applied) expect(result.confidence).toBe(85)
  })

  it("gate uses REPORT confidence, not the weighted side score (uniform weights cap at ~33)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "balance", side: "no_trade", confidence: 40 }),
      makeReport({ perspective: "aggressive", side: "short", confidence: 85 }),
    ]

    // reason: with 3 perspectives and uniform weights a single strong signal
    // scores only 1/3 × 85 ≈ 28 — a weighted-score gate could never fire.
    // The report confidence (85) must clear the threshold on its own.
    const result = evaluateOverride(
      reports,
      makeSideScores({ short: 28.33 }),
      true,
      THRESHOLD
    )

    expect(result.applied).toBe(true)
    if (result.applied) {
      expect(result.side).toBe("short")
      expect(result.confidence).toBe(85)
    }
  })
})
