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
  PerspectiveBreakdownEntry,
  NoTradeReasonDetail,
  PerspectiveWeights,
  PlanningAggregationResult,
} from "@/lib/agent/planning/types"
import { computeAgreementBoostedScores } from "@/lib/agent/planning/consensus/scoring"
import type { DeterministicScoringContext } from "@/lib/agent/planning/consensus/scoring"
import { evaluateOverride } from "@/lib/agent/planning/consensus/override"
import { RiskFlag } from "@/lib/agent/shared/risk-flags"

/**
 * @constant UNIFORM_WEIGHTS
 * @description Cold-start perspective weights (no history yet) — every
 *   perspective counts equally. Matches computePerspectiveWeights(null).
 */
const UNIFORM_WEIGHTS: PerspectiveWeights = {
  conservative: 1 / 3,
  balance: 1 / 3,
  aggressive: 1 / 3,
}

/**
 * @constant NO_TRADE_MAJORITY
 * @description Minimum reports returning side "no_trade" for NO_TRADE.
 */
const NO_TRADE_MAJORITY = 2

/**
 * @constant FUNDING_FLAG_MAJORITY
 * @description Minimum reports emitting the funding_overheated enum flag for NO_TRADE.
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
 * @constant STRONG_SIGNAL_CONFIDENCE
 * @description Confidence at or above which a minority signal is strong
 * enough to re-deploy instead of honoring the no_trade majority.
 */
const STRONG_SIGNAL_CONFIDENCE = 70

/**
 * @constant NO_TRADE_LOW_AVG_CONFIDENCE
 * @description Average confidence below which the no_trade verdict is
 * dismissed as low-conviction (swarm said no, but weakly).
 */
const NO_TRADE_LOW_AVG_CONFIDENCE = 40

/**
 * @constant NO_TRADE_MAX_CONFIDENCE
 * @description Maximum per-perspective confidence for a unanimous-weak
 * no-trade verdict (all individually below this threshold).
 */
const NO_TRADE_MAX_CONFIDENCE = 50

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
  // ponytail: strict comparison — equal counts → null → RE-DEPLOY
  return long > short ? "long" : short > long ? "short" : null
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
 * @function computeNoTradeDecision
 * @description Deterministic rule mapping perspective confidences to a
 * NO_TRADE / RE-DEPLOY reason detail. Rules, in order:
 *   any confidence ≥ 70 → RE_DEPLOY_STRONG_MINORITY (a strong minority signal
 *   deserves re-deployment, not a no-trade)
 *   else average < 40 → NO_TRADE_LOW_AVG (swarm unanimous but low conviction)
 *   else all < 50 → NO_TRADE_UNANIMOUS_WEAK (unanimous but individually weak)
 *   else RE_DEPLOY_MIDDLE (mixed conviction → re-deploy)
 * avgConfidence is the mean over the array; highestConfidence is its max.
 * @param {number[]} confidences - The perspective confidence values (1-3,
 *   nulls filtered by the caller).
 * @returns {NoTradeReasonDetail} The deterministic reason detail.
 */
export function computeNoTradeDecision(confidences: number[]): NoTradeReasonDetail {
  if (confidences.length === 0) {
    // reason: no usable confidence — fall back to unanimous-weak so callers
    // land on NO_TRADE rather than inventing a strong signal from nothing.
    return { rule: "NO_TRADE_UNANIMOUS_WEAK", avgConfidence: 0, highestConfidence: 0 }
  }
  const avgConfidence = confidences.reduce((sum, c) => sum + c, 0) / confidences.length
  const highestConfidence = Math.max(...confidences)
  if (highestConfidence >= STRONG_SIGNAL_CONFIDENCE) {
    return { rule: "RE_DEPLOY_STRONG_MINORITY", avgConfidence, highestConfidence }
  }
  if (avgConfidence < NO_TRADE_LOW_AVG_CONFIDENCE) {
    return { rule: "NO_TRADE_LOW_AVG", avgConfidence, highestConfidence }
  }
  if (highestConfidence < NO_TRADE_MAX_CONFIDENCE) {
    return { rule: "NO_TRADE_UNANIMOUS_WEAK", avgConfidence, highestConfidence }
  }
  return { rule: "RE_DEPLOY_MIDDLE", avgConfidence, highestConfidence }
}

/**
 * @function buildPerspectiveBreakdown
 * @description Maps each perspective report to a transparency entry: side,
 * confidence (report confidence, falling back to score), reasoning, funding
 * flag, failed tools, and degradation status.
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @param {boolean} degraded - Whether the run's DD was degraded.
 * @returns {PerspectiveBreakdownEntry[]} One entry per report.
 */
function buildPerspectiveBreakdown(
  reports: PerspectiveReport[],
  degraded: boolean
): PerspectiveBreakdownEntry[] {
  return reports.map((r) => ({
    perspective: r.perspective,
    side: r.side,
    // reason: confidence and score are both nullable — prefer the explicit
    // confidence, fall back to score, floor at 0.
    confidence: r.confidence ?? r.score ?? 0,
    reason: r.reasoning,
    // reason: structured enum membership only — LLM free-text prose is
    // narrative and never gates (P4 SA2).
    fundingFlag: r.risk_flags.some((f) => f === RiskFlag.funding_overheated),
    toolsFailed: r.errors,
    // reason: a perspective counts as degraded when the run is degraded or
    // its own score is missing (its verdict lacks data support).
    degraded: degraded || r.score === null,
  }))
}

/**
 * @function evaluateConsensus
 * @description Deterministic first-match-wins evaluation of the planning
 * swarm's reports and aggregation into a single decision (spec §8.1).
 * Rules, in order:
 *   1. All reports failed (score === null) → FAILED
 *   2. ≥2 reports no_trade → NO_TRADE / RE-DEPLOY from computeNoTradeDecision
 *      (strong minority or mixed conviction re-deploys instead)
 *   3. ≥2 reports emit the funding_overheated enum flag → NO_TRADE (overheating)
 *   4. All reports same side + aggregation.confidence_score ≥ 60 +
 *      profit_feasible → ACCEPT
 *   5. Exactly 2/3 same side + aggregation.confidence_score ≥ 50 → ACCEPT
 *   6. No aggregation / confidence < 50 / no majority → RE-DEPLOY
 *   7. Fallback → RE-DEPLOY (message explains why nothing above matched)
 * L3 strong-minority override: inside Rule 2, a weighted side score ≥ 70
 * backed by a strong perspective signal and feasible R:R rescues the side
 * from the no_trade majority — the verdict becomes RE-DEPLOY and the result
 * carries the override detail so the orchestrator can apply it to the
 * aggregation when the re-deploy cap forces acceptance. Unanimous refusals
 * are never rescued.
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
 * @param {PerspectiveWeights} [weights] - Per-perspective weights for the
 *   weighted scoring layer (L1). Defaults to uniform (cold-start).
 * @param {DeterministicScoringContext} [deterministic] - DD-level context
 *   (factor scores + graph-memory pattern stats) that switches per-report
 *   confidence in the L2 side scores to deterministic computation (SA3).
 *   Absent → legacy confidence ?? score ?? 0 fallback.
 * @returns {ConsensusResult} The evaluation outcome.
 */
export function evaluateConsensus(
  reports: PerspectiveReport[],
  aggregation: PlanningAggregationResult | null,
  degradedFactors?: string[],
  weights: PerspectiveWeights = UNIFORM_WEIGHTS,
  deterministic?: DeterministicScoringContext
): ConsensusResult {
  const contradictions = aggregation?.contradictions ?? []
  const degraded = degradedFactors !== undefined && degradedFactors.length > 0
  const degradedFlag = degraded ? { degraded: true as const } : {}
  const degradedSuffix =
    degraded && degradedFactors && degradedFactors.length > 0
      ? ` [insufficient data: failed factors: ${degradedFactors.join(", ")}]`
      : ""
  const breakdown = buildPerspectiveBreakdown(reports, degraded)
  // reason: L2 — weighted side scores (weight × confidence per side, boosted
  // by cross-perspective numerical agreement). Single source consumed by the
  // L3 override below and surfaced on every result for transparency. When DD
  // context is provided, per-report confidence is computed deterministically.
  const sideScores = computeAgreementBoostedScores(reports, weights, deterministic)
  // reason: confidence falls back to score; nulls are dropped so the
  // decision only counts confidences that actually exist (1-3 elements).
  const confidences = reports
    .map((r) => r.confidence ?? r.score)
    .filter((c): c is number => c !== null)

  // Rule 1 — all perspectives failed (score === null)
  if (reports.every((r) => r.score === null)) {
    return {
      decision: "FAILED",
      lowConsensusPerspectives: reports.map((r) => r.perspective),
      contradictions,
      message: "All 3 perspective subagents failed to produce a valid plan.",
      ...degradedFlag,
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: null,
      weights,
      sideScores,
      overrideRule: { applied: false },
    }
  }

  // Rule 2 — ≥2 reports return no_trade (hybrid: confidence decides)
  const noTradeCount = reports.filter((r) => r.side === "no_trade").length
  if (noTradeCount >= NO_TRADE_MAJORITY) {
    const noTradeDetail = computeNoTradeDecision(confidences)
    const noTradeReason = aggregation?.no_trade_reason
      ? `${aggregation.no_trade_reason}${degradedSuffix}`
      : undefined
    // reason: unanimous abstention — every perspective said no_trade, so there
    // is no strong minority signal for 2b to rescue. Confidence is
    // irrelevant: a strong/middle unanimous refusal stays NO_TRADE (old Rule 2
    // behavior), never RE-DEPLOY. computeNoTradeDecision is side-agnostic, so
    // the unanimity check lives here where side data exists.
    if (noTradeCount === reports.length) {
      return {
        decision: "NO_TRADE",
        lowConsensusPerspectives: [],
        contradictions,
        message: `All ${reports.length} perspectives returned no_trade — unanimous abstention.`,
        // reason: degraded NO_TRADE suffixes the reason with the failed factors
        // so downstream callers see the decision was data-driven, not conviction.
        noTradeReason,
        ...degradedFlag,
        perspectiveBreakdown: breakdown,
        noTradeReasonDetail: { ...noTradeDetail, rule: "NO_TRADE_UNANIMOUS" },
        weights,
        sideScores,
        overrideRule: { applied: false },
      }
    }
    // reason: L3 strong-minority override — a weighted side score ≥ threshold
    // backed by a strong perspective signal and feasible R:R rescues the side
    // decision from the no_trade majority. The decision becomes RE-DEPLOY so
    // the loop gives the abstainers one more pass; when the per-perspective
    // cap forces acceptance, the orchestrator applies this override to the
    // aggregation (side + deterministic confidence) instead of the LLM's
    // no_trade. Unanimous refusals never reach this check (evaluateOverride
    // has no long/short candidate, and the unanimity branch above already
    // returned).
    const overrideDetail = evaluateOverride(
      reports,
      sideScores,
      aggregation?.profit_feasible === true,
      STRONG_SIGNAL_CONFIDENCE
    )
    if (overrideDetail.applied) {
      return {
        decision: "RE-DEPLOY",
        lowConsensusPerspectives: reports
          .filter((r) => r.side === "no_trade")
          .map((r) => r.perspective),
        contradictions,
        message: (degraded ? "[degraded DD] " : "") +
          `Strong minority ${overrideDetail.side} signal (confidence ${overrideDetail.confidence}, ${overrideDetail.triggeredBy}) overrides the no_trade majority — re-deploying abstainers.`,
        noTradeReason,
        ...degradedFlag,
        perspectiveBreakdown: breakdown,
        noTradeReasonDetail: null,
        weights,
        sideScores,
        overrideRule: overrideDetail,
      }
    }
    // reason: strong-minority / middle means the swarm is not unanimous
    // enough to trust the no-trade — re-deploy the no_trade perspectives
    // instead of honoring a weakly-supported refusal.
    if (
      noTradeDetail.rule === "RE_DEPLOY_STRONG_MINORITY" ||
      noTradeDetail.rule === "RE_DEPLOY_MIDDLE"
    ) {
      return {
        decision: "RE-DEPLOY",
        lowConsensusPerspectives: reports
          .filter((r) => r.side === "no_trade")
          .map((r) => r.perspective),
        contradictions,
        message: (degraded ? "[degraded DD] " : "") +
          `${noTradeCount} of ${reports.length} perspectives returned no_trade with ${noTradeDetail.rule} confidence — re-deploying.`,
        noTradeReason,
        ...degradedFlag,
        perspectiveBreakdown: breakdown,
        noTradeReasonDetail: noTradeDetail,
        weights,
        sideScores,
        overrideRule: { applied: false },
      }
    }
    return {
      decision: "NO_TRADE",
      lowConsensusPerspectives: [],
      contradictions,
      message: `${noTradeCount} of ${reports.length} perspectives returned no_trade — market not worth trading.`,
      // reason: degraded NO_TRADE suffixes the reason with the failed factors
      // so downstream callers see the decision was data-driven, not conviction.
      noTradeReason,
      ...degradedFlag,
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: noTradeDetail,
      weights,
      sideScores,
      overrideRule: { applied: false },
    }
  }

  // Rule 3 — ≥2 reports emit the funding_overheated enum flag (overheating)
  const fundingFlagCount = reports.filter((r) =>
    r.risk_flags.some((f) => f === RiskFlag.funding_overheated)
  ).length
  if (fundingFlagCount >= FUNDING_FLAG_MAJORITY) {
    return {
      decision: "NO_TRADE",
      lowConsensusPerspectives: [],
      contradictions,
      message: `${fundingFlagCount} of ${reports.length} perspectives flagged an overheated funding regime — no trade.`,
      ...degradedFlag,
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: computeNoTradeDecision(confidences),
      weights,
      sideScores,
      overrideRule: { applied: false },
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
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: null,
      weights,
      sideScores,
      overrideRule: { applied: false },
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
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: null,
      weights,
      sideScores,
      overrideRule: { applied: false },
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
      perspectiveBreakdown: breakdown,
      noTradeReasonDetail: computeNoTradeDecision(confidences),
      weights,
      sideScores,
      overrideRule: { applied: false },
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
    perspectiveBreakdown: breakdown,
    noTradeReasonDetail: computeNoTradeDecision(confidences),
    weights,
    sideScores,
    overrideRule: { applied: false },
  }
}
