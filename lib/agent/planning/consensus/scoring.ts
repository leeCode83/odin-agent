/**
 * @file planning/consensus/scoring.ts
 * @description Layer 2 weighted consensus scoring: per-side scores =
 *   Σ (perspective weight × confidence), with a numerical cross-perspective
 *   agreement multiplier (entry-price spread) applied to long/short. Pure
 *   functions only — no I/O, no state. Consumed by the strong-minority
 *   override (L3) and surfaced on ConsensusResult for transparency.
 * @module planning/consensus/scoring
 * @layer agent
 */

import type {
  PerspectiveReport,
  PerspectiveWeights,
  SideScores,
} from "@/lib/agent/planning/types"

/**
 * @constant SIDES
 * @description The three score keys, always present on SideScores.
 */
const SIDES = ["long", "short", "no_trade"] as const

/**
 * @constant SPREAD_AGREE_THRESHOLD
 * @description Relative entry-price spread below which reports on a side
 *   count as agreeing numerically (mini claim-consensus).
 */
const SPREAD_AGREE_THRESHOLD = 0.05

/**
 * @constant AGREE_MULTIPLIER
 * @description Score boost when a side's reports numerically agree.
 */
const AGREE_MULTIPLIER = 1.1

/**
 * @function computeSideScores
 * @description Per-side weighted consensus scores:
 *   score(side) = Σ over reports with r.side === side of (weights[r.perspective]
 *   × conf), where conf = r.confidence ?? r.score ?? 0 (same fallback chain
 *   evaluate.ts uses). All three keys always present, defaulting to 0.
 *   Pure — no mutation of inputs.
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @param {PerspectiveWeights} weights - Per-perspective consensus weights.
 * @returns {SideScores} Weighted score per side, all three keys present.
 */
export function computeSideScores(
  reports: PerspectiveReport[],
  weights: PerspectiveWeights
): SideScores {
  const scores: SideScores = { long: 0, short: 0, no_trade: 0 }
  for (const r of reports) {
    // reason: same confidence ?? score ?? 0 fallback chain as evaluate.ts —
    // nullable confidence prefers the explicit value, then score, then 0.
    const conf = r.confidence ?? r.score ?? 0
    scores[r.side] += weights[r.perspective] * conf
  }
  return scores
}

/**
 * @function agreementMultiplier
 * @description Numerical cross-perspective agreement for one side (mini
 *   version of TrustTrade's claim-consensus): considers only reports with
 *   r.side === side and entry_price > 0. Fewer than 2 such reports → 1 (no
 *   agreement signal). Otherwise relative spread = (maxEntry − minEntry) /
 *   meanEntry; spread < 5% → 1.1, else 1.0.
 * // ponytail: entry-price spread only; SL/TP + semantic agreement when needed
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @param {"long" | "short"} side - The side to measure agreement on.
 * @returns {number} 1.1 when the side's entries agree, else 1.
 */
export function agreementMultiplier(
  reports: PerspectiveReport[],
  side: "long" | "short"
): number {
  const entries = reports
    .filter((r) => r.side === side && r.entry_price > 0)
    .map((r) => r.entry_price)
  // reason: fewer than 2 entries — no agreement signal, no boost.
  if (entries.length < 2) return 1
  const maxEntry = Math.max(...entries)
  const minEntry = Math.min(...entries)
  const meanEntry = entries.reduce((sum, e) => sum + e, 0) / entries.length
  const relativeSpread = (maxEntry - minEntry) / meanEntry
  return relativeSpread < SPREAD_AGREE_THRESHOLD ? AGREE_MULTIPLIER : 1
}

/**
 * @function computeAgreementBoostedScores
 * @description Side scores with the agreement multiplier applied: starts from
 *   computeSideScores, then for "long" and "short" only (never no_trade)
 *   multiplies by agreementMultiplier and rounds to 2 decimals. Pure — builds
 *   a fresh object, no mutation.
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @param {PerspectiveWeights} weights - Per-perspective consensus weights.
 * @returns {SideScores} Agreement-boosted per-side scores.
 */
export function computeAgreementBoostedScores(
  reports: PerspectiveReport[],
  weights: PerspectiveWeights
): SideScores {
  const scores = computeSideScores(reports, weights)
  for (const side of SIDES) {
    if (side === "no_trade") continue
    // reason: 2-decimal rounding keeps boosted scores free of float noise
    // while preserving sub-1 increments after the ×1.1 boost.
    scores[side] = Math.round(scores[side] * agreementMultiplier(reports, side) * 100) / 100
  }
  return scores
}
