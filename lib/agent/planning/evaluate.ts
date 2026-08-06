/**
 * @file planning/evaluate.ts
 * @description Layer 1 deterministic consensus evaluation (spec §8.1).
 * Maps the three perspective reports plus the aggregation result to a single
 * ConsensusResult decision. Rules are FIRST-MATCH-WINS in the exact order
 * defined by the spec table — do not reorder; tests assert ordering.
 * @module planning/evaluate
 * @layer agent
 */

import type {
  ConsensusResult,
  PerspectiveReport,
  PlanningAggregationResult,
} from "@/lib/agent/planning/types"

/**
 * @constant NO_TRADE_MAJORITY
 * @description Minimum reports returning side "no_trade" for NO_TRADE.
 */
const NO_TRADE_MAJORITY = 2

/**
 * @constant FUNDING_FLAG_KEYWORD
 * @description Lowercase substring that marks a risk flag as funding-related
 * (spec §8.1 row 6 — funding regime overheated).
 */
const FUNDING_FLAG_KEYWORD = "funding"

/**
 * @constant FUNDING_FLAG_MAJORITY
 * @description Minimum reports flagging funding for NO_TRADE.
 */
const FUNDING_FLAG_MAJORITY = 2

/**
 * @constant FULL_CONSENSUS_CONFIDENCE
 * @description Minimum aggregation confidence for the all-same-side ACCEPT.
 */
const FULL_CONSENSUS_CONFIDENCE = 60

/**
 * @constant MAJORITY_CONFIDENCE
 * @description Minimum aggregation confidence for the 2/3-majority ACCEPT.
 */
const MAJORITY_CONFIDENCE = 50

/**
 * @function flagReportsFunding
 * @description Counts reports whose joined-lowercase risk_flags mention funding.
 * // reason: joined-lowercase keeps the check case-insensitive and robust to
 * // flag phrasing ("Funding rate extreme", "funding_overheat", ...).
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @returns {number} Count of reports flagging funding.
 */
function flagReportsFunding(reports: PerspectiveReport[]): number {
  return reports.filter((r) =>
    r.risk_flags.join(" ").toLowerCase().includes(FUNDING_FLAG_KEYWORD)
  ).length
}

/**
 * @function sideCounts
 * @description Counts reports per trade side (long/short only; no_trade is
 * handled by earlier rules).
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @returns {{ long: number; short: number }} Counts per side.
 */
function sideCounts(reports: PerspectiveReport[]): { long: number; short: number } {
  const counts = { long: 0, short: 0 }
  for (const r of reports) {
    if (r.side === "long" || r.side === "short") counts[r.side]++
  }
  return counts
}

/**
 * @function majoritySide
 * @description The side held by the most reports, or null when no side
 * reaches a strict majority (>= 2 for three perspectives).
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @returns {"long" | "short" | null} The majority side, if any.
 */
function majoritySide(reports: PerspectiveReport[]): "long" | "short" | null {
  const { long, short } = sideCounts(reports)
  const majority = Math.max(long, short)
  if (majority < NO_TRADE_MAJORITY) return null
  return long >= short ? "long" : "short"
}

/**
 * @function lowConsensusPerspectives
 * @description Perspectives that are disagreeing with the majority side or
 * individually low-confidence (spec §8.1 — "disagreeing/low-confidence").
 * When no majority side exists, all perspectives count as low-consensus.
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @param {"long" | "short" | null} majority - The majority side, if any.
 * @returns {string[]} Perspective names to re-deploy.
 */
function lowConsensusPerspectives(
  reports: PerspectiveReport[],
  majority: "long" | "short" | null
): string[] {
  // reason: with no majority side, every perspective is by definition
  // disagreeing — all count as low-consensus.
  if (majority === null) return reports.map((r) => r.perspective)
  return reports
    .filter(
      (r) =>
        r.side !== majority ||
        r.confidence === null ||
        r.confidence < MAJORITY_CONFIDENCE
    )
    .map((r) => r.perspective)
}

/**
 * @function evaluateConsensus
 * @description Deterministic first-match-wins evaluation of the planning
 * swarm's reports and aggregation into a single decision (spec §8.1).
 * Rules, in order:
 *   1. All reports failed (score === null) → FAILED
 *   2. ≥2 reports no_trade → NO_TRADE (reason from aggregation.no_trade_reason)
 *   3. ≥2 reports flag funding in risk_flags → NO_TRADE (overheating)
 *   4. All reports same side + aggregation.confidence_score ≥ 60 +
 *      profit_feasible → ACCEPT
 *   5. Exactly 2/3 same side + aggregation.confidence_score ≥ 50 → ACCEPT
 *   6. No aggregation / confidence < 50 / no majority → RE-DEPLOY
 *   7. Fallback → RE-DEPLOY (message explains why nothing above matched)
 * Degraded-DD signaling (F3): when `degradedFactors` is non-empty, every
 * result is marked `degraded: true`, NO_TRADE reasons get the failed-factors
 * suffix, and RE-DEPLOY messages are labeled "[degraded DD]" so retries for
 * missing data are distinguishable from retries for low consensus. Rule
 * ordering is unchanged.
 * @param {PerspectiveReport[]} reports - The three perspective reports.
 * @param {PlanningAggregationResult | null} aggregation - Aggregated reasoning
 *   (null when aggregation failed).
 * @param {string[]} [degradedFactors] - Names of DD factors that failed
 *   (score null or missing). Omit when DD was complete.
 * @returns {ConsensusResult} The evaluation outcome.
 */
export function evaluateConsensus(
  reports: PerspectiveReport[],
  aggregation: PlanningAggregationResult | null,
  degradedFactors?: string[]
): ConsensusResult {
  const contradictions = aggregation?.contradictions ?? []
  const degraded = degradedFactors !== undefined && degradedFactors.length > 0
  const degradedFlag = degraded ? { degraded: true as const } : {}
  const degradedSuffix =
    degraded && degradedFactors && degradedFactors.length > 0
      ? ` [insufficient data: failed factors: ${degradedFactors.join(", ")}]`
      : ""

  // Rule 1 — all perspectives failed (score === null)
  if (reports.every((r) => r.score === null)) {
    return {
      decision: "FAILED",
      lowConsensusPerspectives: reports.map((r) => r.perspective),
      contradictions,
      message: "All 3 perspective subagents failed to produce a valid plan.",
      ...degradedFlag,
    }
  }

  // Rule 2 — ≥2 reports return no_trade
  const noTradeCount = reports.filter((r) => r.side === "no_trade").length
  if (noTradeCount >= NO_TRADE_MAJORITY) {
    return {
      decision: "NO_TRADE",
      lowConsensusPerspectives: [],
      contradictions,
      message: `${noTradeCount} of ${reports.length} perspectives returned no_trade — market not worth trading.`,
      // reason: degraded NO_TRADE suffixes the reason with the failed factors
      // so downstream callers see the decision was data-driven, not conviction.
      noTradeReason: aggregation?.no_trade_reason
        ? `${aggregation.no_trade_reason}${degradedSuffix}`
        : undefined,
      ...degradedFlag,
    }
  }

  // Rule 3 — ≥2 reports flag funding (overheating)
  const fundingFlagCount = flagReportsFunding(reports)
  if (fundingFlagCount >= FUNDING_FLAG_MAJORITY) {
    return {
      decision: "NO_TRADE",
      lowConsensusPerspectives: [],
      contradictions,
      message: `${fundingFlagCount} of ${reports.length} perspectives flagged an overheated funding regime — no trade.`,
      ...degradedFlag,
    }
  }

  const majority = majoritySide(reports)
  const allSameSide = majority !== null && sideCounts(reports)[majority] === reports.length
  const confidence = aggregation?.confidence_score ?? -1

  // Rule 4 — all same side, confidence ≥ 60, profit feasible
  if (allSameSide && confidence >= FULL_CONSENSUS_CONFIDENCE && aggregation?.profit_feasible === true) {
    return {
      decision: "ACCEPT",
      lowConsensusPerspectives: [],
      contradictions,
      message: `All ${reports.length} perspectives aligned on ${majority}; aggregation confidence ${confidence}.`,
      ...degradedFlag,
    }
  }

  // Rule 5 — exactly 2/3 same side, confidence ≥ 50
  if (
    majority !== null &&
    sideCounts(reports)[majority] === NO_TRADE_MAJORITY &&
    confidence >= MAJORITY_CONFIDENCE
  ) {
    return {
      decision: "ACCEPT",
      lowConsensusPerspectives: [],
      contradictions,
      message: `${NO_TRADE_MAJORITY} of ${reports.length} perspectives agreed on ${majority}; aggregation confidence ${confidence}.`,
      ...degradedFlag,
    }
  }

  // Rule 6 — low confidence or 1-2 perspectives disagree
  if (aggregation === null || confidence < MAJORITY_CONFIDENCE || majority === null) {
    return {
      decision: "RE-DEPLOY",
      lowConsensusPerspectives: lowConsensusPerspectives(reports, majority),
      contradictions,
      // reason: "[degraded DD]" prefix distinguishes retries-for-missing-data
      // from retries-for-low-consensus in logs.
      message: (degraded ? "[degraded DD] " : "") +
        (aggregation === null
          ? "Aggregation failed — no confidence source; re-deploying perspectives."
          : majority === null
            ? "No side majority among perspectives; re-deploying all perspectives."
            : `Aggregation confidence ${confidence} below ${MAJORITY_CONFIDENCE}; re-deploying low-consensus perspectives.`),
      ...degradedFlag,
    }
  }

  // Rule 7 — fallback: unexplained RE-DEPLOY
  return {
    decision: "RE-DEPLOY",
    lowConsensusPerspectives: lowConsensusPerspectives(reports, majority),
    contradictions,
    message: (degraded ? "[degraded DD] " : "") +
      `Consensus evaluation fell through all rules (side ${majority}, confidence ${confidence}); re-deploying.`,
    ...degradedFlag,
  }
}
