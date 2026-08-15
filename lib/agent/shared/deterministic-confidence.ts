/**
 * @file shared/deterministic-confidence.ts
 * @description Deterministic trade confidence, computed in code — never
 *   self-assessed by an LLM. The proposed trade side is compared against
 *   plain typed inputs (DD factor scores, graph-memory pattern stats,
 *   validated signals, perspective votes) to produce a 0-100 score plus a
 *   three-part breakdown. Pure functions only — no IO, no state, no LLM.
 * @module shared/deterministic-confidence
 * @layer agent
 */

/**
 * @constant NEUTRAL_MIDPOINT
 * @description Factor score at which a factor is directionally neutral
 *   (above = bullish, below = bearish). Matches the DD 0-100 score scale.
 */
const NEUTRAL_MIDPOINT = 50

/**
 * @constant NO_HISTORY_DEFAULT
 * @description Conservative historical_match score when get_graph_patterns
 *   returned no data (totalCount 0). Low, not zero, so an absence of history
 *   reads as uncertainty rather than a fabricated contrary signal.
 */
const NO_HISTORY_DEFAULT = 30

/**
 * @constant SIGNAL_AGREEMENT_BOOST
 * @description Signal-strength multiplier ceiling lift: ×(1 + BOOST) at full
 *   cross-perspective side agreement, scaling linearly with the same-side
 *   vote ratio.
 */
const SIGNAL_AGREEMENT_BOOST = 0.5

/**
 * @constant NO_TRADE_SCORE
 * @description factor_alignment when the proposed side is no_trade — a
 *   directionless side can never align with bullish/bearish factors.
 */
const NO_TRADE_SCORE = 0

/**
 * @type Side
 * @description The trade side being scored.
 */
export type Side = "long" | "short" | "no_trade"

/**
 * @type Direction
 * @description Directional stance of a factor or signal.
 */
export type Direction = "bullish" | "bearish" | "neutral"

/**
 * @interface FactorScoreInput
 * @description One DD factor score. `score` is the 0-100 factor score (null
 *   when the factor failed). `direction` optionally overrides the direction
 *   inferred from the score midpoint.
 */
export interface FactorScoreInput {
  score: number | null
  direction?: Direction
}

/**
 * @interface HistoricalMatchInput
 * @description get_graph_patterns results, pre-collapsed to counts. The
 *   caller maps the tool's pattern outcomes (arbitrary strings) to side
 *   alignment before calling; the module stays vocabulary-agnostic.
 */
export interface HistoricalMatchInput {
  alignedCount: number
  totalCount: number
}

/**
 * @interface SignalStrengthInput
 * @description A single validated signal: its direction and strength (0-100).
 */
export interface SignalStrengthInput {
  direction: Direction
  strength: number
}

/**
 * @interface DeterministicConfidenceInput
 * @description All plain-data inputs to the deterministic confidence
 *   computation. No IO, no LLM — callers resolve these from tool/DB results.
 */
export interface DeterministicConfidenceInput {
  /** The proposed trade side. */
  side: Side
  /** DD factor scores (null = failed factor). */
  factorScores: FactorScoreInput[]
  /** Graph-memory pattern match stats for the proposed side. */
  historicalMatches: HistoricalMatchInput
  /** Validated signals supporting the trade. */
  signals: SignalStrengthInput[]
  /** Trade-side votes from the planning perspectives. */
  votes: Side[]
}

/**
 * @interface ConfidenceBreakdownResult
 * @description The three deterministic sub-scores, each an integer in [0,100].
 *   Mirrors ConfidenceBreakdown from agent/types.
 */
export interface ConfidenceBreakdownResult {
  factor_alignment: number
  historical_match: number
  signal_strength: number
}

/**
 * @interface DeterministicConfidenceResult
 * @description Overall deterministic confidence (integer, 0-100) plus its
 *   breakdown. Consumed by the autonomy gate and consensus scoring.
 */
export interface DeterministicConfidenceResult {
  score: number
  breakdown: ConfidenceBreakdownResult
}

/**
 * @function clamp
 * @description Bounds a number to [0, 100].
 * @param {number} value - The raw value.
 * @returns {number} The value clamped to [0, 100].
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/**
 * @function directionOf
 * @description Resolves a factor's direction: explicit direction wins, else
 *   inferred from the score midpoint (>50 bullish, <50 bearish, =50 neutral).
 * @param {FactorScoreInput} factor - The factor input.
 * @returns {Direction} The resolved direction.
 */
function directionOf(factor: FactorScoreInput): Direction {
  if (factor.direction) return factor.direction
  if (factor.score === null) return "neutral"
  if (factor.score > NEUTRAL_MIDPOINT) return "bullish"
  if (factor.score < NEUTRAL_MIDPOINT) return "bearish"
  return "neutral"
}

/**
 * @function alignsWith
 * @description Whether a direction aligns with a proposed side: bullish aligns
 *   with long, bearish with short. Neutral directions and no_trade sides never
 *   align.
 * @param {Side} side - The proposed trade side.
 * @param {Direction} direction - The factor/signal direction.
 * @returns {boolean} True when the direction supports the side.
 */
export function alignsWith(side: Side, direction: Direction): boolean {
  if (side === "no_trade") return false
  return (side === "long" && direction === "bullish") || (side === "short" && direction === "bearish")
}

/**
 * @function factorAlignmentScore
 * @description factor_alignment: the percentage of DD factor scores whose
 *   direction aligns with the proposed side (bullish on long, bearish on
 *   short). Null/failed factors count as non-aligned (conservative). Empty
 *   input and no_trade sides score 0.
 * @param {FactorScoreInput[]} factorScores - The DD factor scores.
 * @param {Side} side - The proposed trade side.
 * @returns {number} Integer percentage of aligned factors in [0, 100].
 */
export function factorAlignmentScore(factorScores: FactorScoreInput[], side: Side): number {
  if (side === "no_trade" || factorScores.length === 0) return NO_TRADE_SCORE
  const aligned = factorScores.filter((f) => alignsWith(side, directionOf(f))).length
  return Math.round((aligned / factorScores.length) * 100)
}

/**
 * @function historicalMatchScore
 * @description historical_match: the percentage of historical patterns whose
 *   outcome aligned with the proposed side. No data (totalCount 0) falls back
 *   to a conservative low default instead of a fabricated 0 or 100.
 * @param {HistoricalMatchInput} historical - Pattern match counts.
 * @returns {number} Integer match percentage in [0, 100], or the no-data
 *   default when no patterns exist.
 */
export function historicalMatchScore(historical: HistoricalMatchInput): number {
  if (historical.totalCount === 0) return NO_HISTORY_DEFAULT
  return Math.round(clamp((historical.alignedCount / historical.totalCount) * 100))
}

/**
 * @function signalStrengthScore
 * @description signal_strength: the mean strength of the aligned signals
 *   (bullish on long, bearish on short), boosted by cross-perspective
 *   agreement — the same-side vote ratio lifts the base by up to ×(1 +
 *   SIGNAL_AGREEMENT_BOOST) at full agreement. No aligned signals → 0.
 * @param {SignalStrengthInput[]} signals - The validated signals.
 * @param {Side} side - The proposed trade side.
 * @param {Side[]} votes - The planning perspectives' side votes.
 * @returns {number} Integer signal strength in [0, 100].
 */
export function signalStrengthScore(signals: SignalStrengthInput[], side: Side, votes: Side[]): number {
  const aligned = signals.filter((s) => alignsWith(side, s.direction))
  if (aligned.length === 0) return 0
  const base = aligned.reduce((sum, s) => sum + s.strength, 0) / aligned.length
  const totalVotes = votes.length
  const sameSide = votes.filter((v) => v === side).length
  const ratio = totalVotes === 0 ? 0 : sameSide / totalVotes
  const boost = 1 + SIGNAL_AGREEMENT_BOOST * ratio
  return Math.round(clamp(base * boost))
}

/**
 * @function deterministicConfidence
 * @description The overall deterministic confidence score and breakdown.
 *   score = round((factor_alignment + historical_match + signal_strength) / 3),
 *   an equal-weight blend of the three breakdown fields; each field and the
 *   final score are integers in [0, 100]. Empty inputs produce a conservative
 *   low score (no crash) because historical_match defaults low and the other
 *   fields floor at 0.
 * @param {DeterministicConfidenceInput} inputs - All plain-data inputs.
 * @returns {DeterministicConfidenceResult} The blended score and breakdown.
 */
export function deterministicConfidence(inputs: DeterministicConfidenceInput): DeterministicConfidenceResult {
  const factor_alignment = factorAlignmentScore(inputs.factorScores, inputs.side)
  const historical_match = historicalMatchScore(inputs.historicalMatches)
  const signal_strength = signalStrengthScore(inputs.signals, inputs.side, inputs.votes)
  const score = Math.round((factor_alignment + historical_match + signal_strength) / 3)
  return { score, breakdown: { factor_alignment, historical_match, signal_strength } }
}
