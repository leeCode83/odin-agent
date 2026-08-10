/**
 * @file planning/consensus/weights.ts
 * @description Dynamic weighting layer (L1) for the planning swarm consensus:
 *   performance-derived perspective weights with cold-start smoothing toward
 *   uniform, plus a selective Winner-Takes-All boost (Market Regime Council
 *   pattern) that reverts automatically because it is stateless per call.
 * @module planning/consensus/weights
 * @layer agent
 */

import type {
  Perspective,
  PerspectivePerformance,
  PerspectiveWeights,
  ConsensusWeightConfig,
} from "@/lib/agent/planning/types"

/**
 * @constant DEFAULT_COLD_START_LAMBDA
 * @description Cold-start blend speed: α = 1 − e^(−t/λ) with t = samples seen.
 *   Higher λ = slower trust in early history.
 */
export const DEFAULT_COLD_START_LAMBDA = 20

/**
 * @constant DEFAULT_HISTORY_LIMIT
 * @description Max closed decisions considered per perspective performance query.
 */
export const DEFAULT_HISTORY_LIMIT = 20

/**
 * @constant DEFAULT_WTA_THRESHOLD
 * @description Selective-WTA dominance ratio: best ≥ threshold × second-best.
 */
export const DEFAULT_WTA_THRESHOLD = 3

/**
 * @constant DEFAULT_WTA_WEIGHT
 * @description Selective-WTA temporary weight assigned to the dominant perspective.
 */
export const DEFAULT_WTA_WEIGHT = 0.6

/**
 * @constant DEFAULT_WTA_MIN_SAMPLES
 * @description Selective-WTA minimum samples before the boost may apply.
 */
export const DEFAULT_WTA_MIN_SAMPLES = 5

/**
 * @constant DEFAULT_WEIGHT_CONFIG
 * @description Single source of defaults for the dynamic weighting layer (L1).
 *   Callers pass this instead of literal configs so tuning lives in one place.
 */
export const DEFAULT_WEIGHT_CONFIG: ConsensusWeightConfig = {
  coldStartLambda: DEFAULT_COLD_START_LAMBDA,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  wtaThreshold: DEFAULT_WTA_THRESHOLD,
  wtaWeight: DEFAULT_WTA_WEIGHT,
  wtaMinSamples: DEFAULT_WTA_MIN_SAMPLES,
}

/**
 * @constant PERSPECTIVES
 * @description Fixed iteration order of the three perspectives. Order matters:
 *   strict `>` tie-breaking in applyWta keeps equal weights deterministic.
 */
const PERSPECTIVES: Perspective[] = ["conservative", "balance", "aggressive"]

/**
 * @constant UNIFORM_WEIGHT
 * @description Baseline weight per perspective (uniform distribution over 3).
 */
const UNIFORM_WEIGHT = 1 / 3

/**
 * @function perspectiveWinRate
 * @description Win rate of one perspective, with a uniform baseline when it
 *   has no recorded outcomes (no evidence ≠ zero skill).
 * @param {PerspectivePerformance} perf - The perspective's outcome history.
 * @returns {number} correct / total, or 1/3 when total is 0.
 */
function perspectiveWinRate(perf: PerspectivePerformance): number {
  // ponytail: win-rate only, upgrade to Sharpe when history accumulates
  return perf.total === 0 ? UNIFORM_WEIGHT : perf.correct / perf.total
}

/**
 * @function uniformWeights
 * @description Fresh uniform weight object (never the shared constant, so
 *   callers can't corrupt it by mutating a return value).
 * @returns {PerspectiveWeights} Each perspective weighted 1/3.
 */
function uniformWeights(): PerspectiveWeights {
  return {
    conservative: UNIFORM_WEIGHT,
    balance: UNIFORM_WEIGHT,
    aggressive: UNIFORM_WEIGHT,
  }
}

/**
 * @function normalizeWeights
 * @description Scales raw weights so Σ = 1. Guards against all-zero input
 *   (every win rate 0 with full history trust) by falling back to uniform.
 * @param {PerspectiveWeights} weights - Raw, unnormalized weights.
 * @returns {PerspectiveWeights} Weights summing to 1.
 */
function normalizeWeights(weights: PerspectiveWeights): PerspectiveWeights {
  const sum = weights.conservative + weights.balance + weights.aggressive
  // reason: all-zero happens when every perspective has a 0 win rate at full
  // history trust (α = 1) — fall back to uniform instead of NaN division.
  if (sum === 0) return uniformWeights()
  return {
    conservative: weights.conservative / sum,
    balance: weights.balance / sum,
    aggressive: weights.aggressive / sum,
  }
}

/**
 * @function withBaseline
 * @description Fills missing perspective keys with an empty performance record
 *   ({ correct: 0, total: 0 }) so callers can pass `{}`, partial records, or
 *   null-equivalents without crashing. Semantics: a perspective with no
 *   recorded outcomes has no evidence — perspectiveWinRate treats total 0 as
 *   the uniform baseline, never as zero skill.
 * @param {Partial<Record<Perspective, PerspectivePerformance>> | null} perf -
 *   Outcome history per perspective, possibly empty or partial.
 * @returns {Record<Perspective, PerspectivePerformance>} Full three-key record.
 */
function withBaseline(
  perf: Partial<Record<Perspective, PerspectivePerformance>> | null
): Record<Perspective, PerspectivePerformance> {
  if (perf === null) {
    return {
      conservative: { correct: 0, total: 0 },
      balance: { correct: 0, total: 0 },
      aggressive: { correct: 0, total: 0 },
    }
  }
  return {
    conservative: perf.conservative ?? { correct: 0, total: 0 },
    balance: perf.balance ?? { correct: 0, total: 0 },
    aggressive: perf.aggressive ?? { correct: 0, total: 0 },
  }
}

/**
 * @function computePerspectiveWeights
 * @description Performance-derived perspective weights with cold-start
 *   smoothing: α = 1 − e^(−t/λ) where t = fewest samples across perspectives
 *   and λ = coldStartLambda; weight_i = α·winRate_i + (1−α)·(1/3); the blend
 *   is normalized so Σ = 1. Null, empty, or partial performance (cold-start /
 *   DB unavailable / no history yet) yields uniform weights.
 * @param {Partial<Record<Perspective, PerspectivePerformance>> | null} perf -
 *   Outcome history per perspective, or null when unavailable. Missing keys
 *   are treated as empty history (uniform baseline), never a crash.
 * @param {ConsensusWeightConfig} config - Weighting tunables.
 * @returns {PerspectiveWeights} Weights summing to 1.
 */
export function computePerspectiveWeights(
  perf: Partial<Record<Perspective, PerspectivePerformance>> | null,
  config: ConsensusWeightConfig
): PerspectiveWeights {
  if (perf === null) return uniformWeights()
  // reason: normalize first — the DB layer may return `{}` (no rows) or a
  // partial record (a perspective never traded); every key must resolve to a
  // real performance entry before `.total` is read.
  const baseline = withBaseline(perf)
  // reason: t = fewest samples across perspectives — the least-trusted
  // perspective gates how fast the whole blend trusts history.
  const t = Math.min(baseline.conservative.total, baseline.balance.total, baseline.aggressive.total)
  const alpha = 1 - Math.exp(-t / config.coldStartLambda)
  const blended: PerspectiveWeights = {
    conservative:
      alpha * perspectiveWinRate(baseline.conservative) + (1 - alpha) * UNIFORM_WEIGHT,
    balance: alpha * perspectiveWinRate(baseline.balance) + (1 - alpha) * UNIFORM_WEIGHT,
    aggressive:
      alpha * perspectiveWinRate(baseline.aggressive) + (1 - alpha) * UNIFORM_WEIGHT,
  }
  return normalizeWeights(blended)
}

/**
 * @function applyWta
 * @description Selective Winner-Takes-All boost (Market Regime Council
 *   pattern): when the leading perspective dominates the others past
 *   `wtaThreshold` AND has at least `wtaMinSamples` history, reassign it
 *   `wtaWeight` and redistribute the remainder (1 − wtaWeight) across the
 *   other two proportionally to their original weights (evenly when both are
 *   zero). Stateless per call, so the boost reverts automatically next
 *   evaluation. Null, empty, or partial performance skips the boost.
 * @param {PerspectiveWeights} weights - Blended weights from
 *   computePerspectiveWeights.
 * @param {Partial<Record<Perspective, PerspectivePerformance>> | null} perf -
 *   Outcome history per perspective, or null when unavailable. Missing keys
 *   are treated as empty history — the boost simply cannot apply to them.
 * @param {ConsensusWeightConfig} config - Weighting tunables.
 * @returns {PerspectiveWeights} Boosted weights, or a copy of the input when
 *   no boost applies. Never the input object itself.
 */
export function applyWta(
  weights: PerspectiveWeights,
  perf: Partial<Record<Perspective, PerspectivePerformance>> | null,
  config: ConsensusWeightConfig
): PerspectiveWeights {
  if (perf === null) return { ...weights }
  const baseline = withBaseline(perf)
  let best: Perspective = PERSPECTIVES[0]
  for (const p of PERSPECTIVES) {
    // reason: strict `>` keeps ties deterministic (first in PERSPECTIVES
    // order wins) — a tie can't dominate, so the choice only matters for
    // which loser gets the larger proportional share.
    if (weights[p] > weights[best]) best = p
  }
  const others = PERSPECTIVES.filter((p) => p !== best)
  const secondBest = Math.max(weights[others[0]], weights[others[1]])
  if (baseline[best].total < config.wtaMinSamples) return { ...weights }
  if (weights[best] < config.wtaThreshold * secondBest) return { ...weights }
  const otherSum = weights[others[0]] + weights[others[1]]
  const boosted = { ...weights }
  boosted[best] = config.wtaWeight
  if (otherSum === 0) {
    // reason: no evidence among the losers — split the remainder evenly.
    const share = (1 - config.wtaWeight) / 2
    boosted[others[0]] = share
    boosted[others[1]] = share
  } else {
    const remainder = 1 - config.wtaWeight
    boosted[others[0]] = remainder * (weights[others[0]] / otherSum)
    boosted[others[1]] = remainder * (weights[others[1]] / otherSum)
  }
  return boosted
}
