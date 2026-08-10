/**
 * @file planning/consensus/override.ts
 * @description Layer 3 strong-minority override (spec §8.3): rescues the
 *   side decision when a no_trade majority (≥2 reports) faces one strong
 *   minority signal. Pure deterministic rule — no I/O, no aggregation, no
 *   dependency on the weighting or scoring layers.
 * @module planning/consensus/override
 * @layer agent
 */

import type {
  OverrideRuleDetail,
  PerspectiveReport,
  SideScores,
} from "@/lib/agent/planning/types"

/**
 * @constant MIN_NO_TRADE_MAJORITY
 * @description Minimum reports returning side "no_trade" for the override to
 *   have a majority to rescue from.
 */
const MIN_NO_TRADE_MAJORITY = 2

/**
 * @function reportConf
 * @description Per-report confidence, preferring the explicit confidence
 *   field, falling back to score, flooring nulls at 0.
 * @param {PerspectiveReport} r - The perspective report.
 * @returns {number} The report's effective confidence (0 when unknown).
 */
function reportConf(r: PerspectiveReport): number {
  return r.confidence ?? r.score ?? 0
}

/**
 * @function evaluateOverride
 * @description Strong-minority override rule (L3): when ≥2 reports abstain
 *   (no_trade) but at least one report sides long/short with confidence ≥
 *   `threshold` AND the trade is profit-feasible, the side decision is
 *   rescued from the no_trade majority. Fires only in that intended scenario
 *   — never on unanimity, never on an already-3-way split (no majority
 *   exists there), never on an infeasible trade. The L2 weighted side scores
 *   break ties when BOTH sides qualify (stronger score wins). `confidence`
 *   in the result is the strongest report confidence on the winning side
 *   (deterministic, directly comparable to the other layers' thresholds),
 *   and `triggeredBy` names the highest-confidence report on that side.
 *   HANDOFF: the integration layer (evaluate.ts) later takes
 *   max(override.confidence, aggregation.confidence_score); this module
 *   computes ONLY the override half and never touches aggregation.
 * @param {PerspectiveReport[]} reports - The three perspective reports.
 * @param {SideScores} sideScores - L2 weighted per-side scores (missing keys
 *   treated as 0) — used for tie-breaking between qualifying sides.
 * @param {boolean} profitFeasible - Whether the aggregated trade is
 *   profit-feasible (feasibility gate wins — never rescue an infeasible trade).
 * @param {number} threshold - Minimum confidence for a minority signal to
 *   count as strong (caller passes STRONG_SIGNAL_CONFIDENCE = 70).
 * @returns {OverrideRuleDetail} The override outcome.
 */
export function evaluateOverride(
  reports: PerspectiveReport[],
  sideScores: SideScores,
  profitFeasible: boolean,
  threshold: number
): OverrideRuleDetail {
  // reason: feasibility gate wins — an infeasible trade is never rescued
  // regardless of how strong the minority signal is.
  if (profitFeasible !== true) return { applied: false }

  const noTradeCount = reports.filter((r) => r.side === "no_trade").length
  // reason: without a ≥2 no_trade majority there is nothing to rescue from —
  // unanimity must never be overridden, and a 3-way split has no majority.
  if (noTradeCount < MIN_NO_TRADE_MAJORITY) return { applied: false }

  // reason: the gate is the STRONGEST REPORT confidence on the side, not the
  // L2 weighted score — with three perspectives and uniform weights a single
  // 85-confidence signal scores only ~28 (1/3 × 85), so a weighted-score gate
  // would never fire. The weighted scores still decide which side wins when
  // both qualify (tie-break below).
  const maxReportConfidenceOnSide = (side: "long" | "short"): number =>
    Math.max(0, ...reports.filter((r) => r.side === side).map(reportConf))

  const qualifies = (side: "long" | "short"): boolean =>
    maxReportConfidenceOnSide(side) >= threshold

  const longQualifies = qualifies("long")
  const shortQualifies = qualifies("short")
  if (!longQualifies && !shortQualifies) return { applied: false }

  // reason: both sides qualify — the stronger L2 score wins the rescue.
  // ponytail: tie → long, revisit if data shows side asymmetry
  const side: "long" | "short" =
    longQualifies && shortQualifies
      ? (sideScores["long"] ?? 0) >= (sideScores["short"] ?? 0)
        ? "long"
        : "short"
      : longQualifies
        ? "long"
        : "short"

  // reason: qualifies(side) guarantees ≥1 report on this side, so onSide[0]
  // exists — the reduce seeds on it and keeps the highest-confidence report.
  const onSide = reports.filter((r) => r.side === side)
  const triggeredBy = onSide.reduce(
    (best, r) => (reportConf(r) > reportConf(best) ? r : best),
    onSide[0]
  ).perspective

  return {
    applied: true,
    side,
    confidence: maxReportConfidenceOnSide(side),
    triggeredBy,
  }
}
