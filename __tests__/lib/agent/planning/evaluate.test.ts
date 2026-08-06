/**
 * @file evaluate.test.ts
 * @description Tests for evaluateConsensus (Layer 1 consensus evaluation).
 * Asserts all 7 first-match-wins decision rules in spec §8.1, including
 * rule ordering and boundary conditions.
 */

import { describe, it, expect } from "vitest"
import { evaluateConsensus } from "@/lib/agent/planning/evaluate"
import type {
  PerspectiveReport,
  PlanningAggregationResult,
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
    suggested_leverage: 3,
    suggested_position_size_usdc: 1000,
    risk_flags: [],
    ...overrides,
  } as PerspectiveReport
}

/**
 * @function makeAggregation
 * @description Builds a minimal valid PlanningAggregationResult with test overrides.
 * @param {Partial<PlanningAggregationResult>} overrides - Fields to override defaults.
 * @returns {PlanningAggregationResult} Aggregation with sensible defaults
 *   (confidence_score 80, side "long", profit_feasible true).
 */
function makeAggregation(
  overrides: Partial<PlanningAggregationResult>
): PlanningAggregationResult {
  return {
    side: "long",
    thesis: "",
    reasoning: "",
    confidence_score: 80,
    confidence_breakdown: { reasoning: 0, data: 0, risk: 0 },
    leverage_suggested: 3,
    risk_flags: [],
    consensus_alignment: 3,
    contradictions: [],
    profit_feasible: true,
    entry_price: 100,
    stop_loss: 95,
    take_profit: 115,
    position_size_usdc: 1000,
    ...overrides,
  } as PlanningAggregationResult
}

describe("evaluateConsensus", () => {
  it("RULE 1 — all 3 reports score === null → FAILED", () => {
    const reports = [
      makeReport({ perspective: "conservative", score: null, confidence: null, errors: ["boom"] }),
      makeReport({ perspective: "balance", score: null, confidence: null, errors: ["boom"] }),
      makeReport({ perspective: "aggressive", score: null, confidence: null, errors: ["boom"] }),
    ]

    const result = evaluateConsensus(reports, makeAggregation({}))

    expect(result.decision).toBe("FAILED")
  })

  it("RULE 1 ordering — all failed beats no_trade majority (first match wins)", () => {
    const reports = [
      makeReport({ perspective: "conservative", score: null, confidence: null, side: "no_trade" }),
      makeReport({ perspective: "balance", score: null, confidence: null, side: "no_trade" }),
      makeReport({ perspective: "aggressive", score: null, confidence: null, side: "no_trade" }),
    ]

    const result = evaluateConsensus(reports, makeAggregation({ side: "no_trade" }))

    expect(result.decision).toBe("FAILED")
  })

  it("RULE 2 — ≥2 reports side no_trade → NO_TRADE with aggregation reason", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade" }),
      makeReport({ perspective: "balance", side: "no_trade" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade", no_trade_reason: "ATR too flat" })
    )

    expect(result.decision).toBe("NO_TRADE")
    expect(result.noTradeReason).toBe("ATR too flat")
  })

  it("RULE 2 — NO_TRADE with null aggregation has no noTradeReason", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade" }),
      makeReport({ perspective: "balance", side: "no_trade" }),
      makeReport({ perspective: "aggressive", side: "short" }),
    ]

    const result = evaluateConsensus(reports, null)

    expect(result.decision).toBe("NO_TRADE")
    expect(result.noTradeReason).toBeUndefined()
  })

  it("RULE 2 ordering — no_trade majority beats funding flags (rule 2 before rule 3)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade", risk_flags: ["funding_rate_extreme"] }),
      makeReport({ perspective: "balance", side: "no_trade", risk_flags: ["funding_rate_extreme"] }),
      makeReport({ perspective: "aggressive", side: "long", risk_flags: [] }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade", no_trade_reason: "ATR too flat" })
    )

    expect(result.decision).toBe("NO_TRADE")
    expect(result.noTradeReason).toBeDefined()
  })

  it("RULE 3 — ≥2 reports risk_flags contain funding (case-insensitive) → NO_TRADE", () => {
    const reports = [
      makeReport({ perspective: "conservative", risk_flags: ["Funding_rate_extreme"] }),
      makeReport({ perspective: "balance", risk_flags: ["funding_rate_extreme"] }),
      makeReport({ perspective: "aggressive", risk_flags: [] }),
    ]

    const result = evaluateConsensus(reports, makeAggregation({}))

    expect(result.decision).toBe("NO_TRADE")
    expect(result.message.toLowerCase()).toContain("funding")
  })

  it("RULE 3 ordering — funding flags beat unanimous high-confidence ACCEPT", () => {
    const reports = [
      makeReport({ perspective: "conservative", risk_flags: ["funding overheat"] }),
      makeReport({ perspective: "balance", risk_flags: ["funding overheat"] }),
      makeReport({ perspective: "aggressive", risk_flags: [] }),
    ]

    const result = evaluateConsensus(reports, makeAggregation({ confidence_score: 95 }))

    expect(result.decision).toBe("NO_TRADE")
  })

  it("RULE 4 — all 3 same side + confidence ≥ 60 + profit feasible → ACCEPT", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 60, profit_feasible: true, contradictions: ["a", "b"] })
    )

    expect(result.decision).toBe("ACCEPT")
    expect(result.contradictions).toEqual(["a", "b"])
  })

  it("RULE 4 — all same side but profit NOT feasible → falls through, not ACCEPT", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 85, profit_feasible: false })
    )

    expect(result.decision).not.toBe("ACCEPT")
  })

  it("RULE 4 — all same side but confidence 59 → not ACCEPT, no 2/3 majority → fallback RE-DEPLOY", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 59, profit_feasible: true })
    )

    expect(result.decision).toBe("RE-DEPLOY")
  })

  it("RULE 5 — exactly 2/3 same side + confidence ≥ 50 → ACCEPT", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "short" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 50 })
    )

    expect(result.decision).toBe("ACCEPT")
  })

  it("RULE 6 — 2/3 same side but confidence 49 → RE-DEPLOY, dissenter in lowConsensusPerspectives", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "short" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 49 })
    )

    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.lowConsensusPerspectives).toEqual(["aggressive"])
  })

  it("RULE 6 — no side majority (long/short/no_trade) → RE-DEPLOY, all perspectives low-consensus", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "short" }),
      makeReport({ perspective: "aggressive", side: "no_trade" }),
    ]

    const result = evaluateConsensus(reports, makeAggregation({ side: "no_trade", confidence_score: 70 }))

    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.lowConsensusPerspectives.sort()).toEqual(
      ["aggressive", "balance", "conservative"]
    )
  })

  it("RULE 6 — null aggregation → RE-DEPLOY (no confidence source)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(reports, null)

    expect(result.decision).toBe("RE-DEPLOY")
  })

  it("RULE 7 — fallback RE-DEPLOY with explanatory message", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "long" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "long", confidence_score: 55, profit_feasible: true })
    )

    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.message.length).toBeGreaterThan(0)
  })

  it("ACCEPT carries aggregation contradictions through", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "short" }),
      makeReport({ perspective: "balance", side: "short" }),
      makeReport({ perspective: "aggressive", side: "short" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "short", contradictions: ["entry price disagreement"] })
    )

    expect(result.decision).toBe("ACCEPT")
    expect(result.contradictions).toEqual(["entry price disagreement"])
  })

  it("DEGRADED — NO_TRADE reason suffixed with failed factors and result marked degraded", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade" }),
      makeReport({ perspective: "balance", side: "no_trade" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade", no_trade_reason: "ATR too flat" }),
      ["technical", "sentiment"]
    )

    expect(result.decision).toBe("NO_TRADE")
    expect(result.noTradeReason).toBe(
      "ATR too flat [insufficient data: failed factors: technical, sentiment]"
    )
    expect(result.degraded).toBe(true)
  })

  it("DEGRADED — RE-DEPLOY message labeled to distinguish retry-for-data", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "long" }),
      makeReport({ perspective: "balance", side: "short" }),
      makeReport({ perspective: "aggressive", side: "no_trade" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade", confidence_score: 70 }),
      ["fundamental"]
    )

    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.message.startsWith("[degraded DD] ")).toBe(true)
    expect(result.degraded).toBe(true)
  })

  it("NOT degraded — NO_TRADE reason unsuffixed and result unflagged (regression)", () => {
    const reports = [
      makeReport({ perspective: "conservative", side: "no_trade" }),
      makeReport({ perspective: "balance", side: "no_trade" }),
      makeReport({ perspective: "aggressive", side: "long" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade", no_trade_reason: "ATR too flat" })
    )

    expect(result.decision).toBe("NO_TRADE")
    expect(result.noTradeReason).toBe("ATR too flat")
    expect(result.degraded).toBeUndefined()
  })

  it("DEGRADED — rule ordering unchanged: failed reports still FAILED before NO_TRADE", () => {
    const reports = [
      makeReport({ perspective: "conservative", score: null, confidence: null, side: "no_trade" }),
      makeReport({ perspective: "balance", score: null, confidence: null, side: "no_trade" }),
      makeReport({ perspective: "aggressive", score: null, confidence: null, side: "no_trade" }),
    ]

    const result = evaluateConsensus(
      reports,
      makeAggregation({ side: "no_trade" }),
      ["technical"]
    )

    expect(result.decision).toBe("FAILED")
    expect(result.noTradeReason).toBeUndefined()
  })
})
