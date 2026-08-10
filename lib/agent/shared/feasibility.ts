/**
 * @file shared/feasibility.ts
 * @description Deterministic profit-feasibility calculator: given entry/SL/TP,
 * side, and the user's target profit, decides whether the target is reachable
 * within the trade's risk/reward geometry (no LLM judgment). Replaces the LLM's
 * guessed `profit_feasible` in the planning aggregation step.
 * @module shared/feasibility
 * @layer util
 */

/**
 * @interface ProfitFeasibilityParams
 * @description Inputs to computeProfitFeasibility.
 * @property {number} entryPrice - Entry price (USDC).
 * @property {number} stopLoss - Stop-loss price (USDC).
 * @property {number} takeProfit - Take-profit price (USDC).
 * @property {"long" | "short"} side - Position side.
 * @property {number} targetProfitPercent - User's profit target as DECIMAL
 *   percent (e.g. 20.5 = 20.5%).
 * @property {number} [atr] - ATR value; when provided, adds an expected-move
 *   check (target ≤ 3×ATR% of entry).
 * @property {number} [minRiskRewardRatio] - Minimum acceptable R:R (default 1.5).
 */
export interface ProfitFeasibilityParams {
  entryPrice: number
  stopLoss: number
  takeProfit: number
  side: "long" | "short"
  targetProfitPercent: number
  atr?: number
  minRiskRewardRatio?: number
}

/**
 * @interface ProfitFeasibilityResult
 * @description Output of computeProfitFeasibility.
 * @property {boolean} feasible - True when every enabled check passes.
 * @property {number} riskRewardRatio - reward / risk, rounded to 2 decimals;
 *   0 when inputs are unusable.
 * @property {number} breakEvenWinRate - 1 / (1 + R:R), rounded to 2 decimals;
 *   0 when inputs are unusable.
 * @property {number} [expectedMovePercent] - (atr / entryPrice) * 100, rounded
 *   to 2 decimals; present only when atr was provided.
 * @property {string[]} reasons - One human-readable line per check result.
 */
export interface ProfitFeasibilityResult {
  feasible: boolean
  riskRewardRatio: number
  breakEvenWinRate: number
  expectedMovePercent?: number
  reasons: string[]
}

/**
 * @function round2
 * @description Rounds a number to 2 decimal places.
 * @param {number} n - Value to round.
 * @returns {number} Rounded value.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * @function computeProfitFeasibility
 * @description Decides deterministically whether the user's target profit is
 *   feasible for the given trade geometry. Checks, all must pass:
 *   (1) R:R = reward/risk ≥ minRiskRewardRatio (default 1.5);
 *   (2) target distance (percent) ≤ TP distance (percent of entry);
 *   (3) when `atr` is provided: target ≤ 3×ATR% of entry (expected move).
 *   risk and reward are absolute entry-to-SL / entry-to-TP distances, so the
 *   math is identical for long and short. Unusable inputs (risk ≤ 0, reward
 *   ≤ 0, or entry ≤ 0) return infeasible with zeroed metrics.
 * @param {ProfitFeasibilityParams} params - Entry/SL/TP, side, target, optional
 *   atr and minRiskRewardRatio.
 * @returns {ProfitFeasibilityResult} Feasibility verdict with per-check reasons.
 */
export function computeProfitFeasibility(params: ProfitFeasibilityParams): ProfitFeasibilityResult {
  const minRR = params.minRiskRewardRatio ?? 1.5
  const risk = Math.abs(params.entryPrice - params.stopLoss)
  const reward = Math.abs(params.takeProfit - params.entryPrice)
  const reasons: string[] = []

  if (params.entryPrice <= 0 || risk <= 0 || reward <= 0) {
    // reason: no positive risk (or no price reference) means R:R and win rate
    // are undefined — zero them and explain instead of dividing by zero.
    if (params.entryPrice <= 0) reasons.push("entry price must be positive")
    if (risk <= 0) reasons.push("risk distance must be positive (stop-loss equals entry)")
    if (reward <= 0) reasons.push("reward distance must be positive (take-profit equals entry)")
    return { feasible: false, riskRewardRatio: 0, breakEvenWinRate: 0, reasons }
  }

  const riskRewardRatio = round2(reward / risk)
  const breakEvenWinRate = round2(1 / (1 + reward / risk))
  const tpDistancePercent = (reward / params.entryPrice) * 100
  const targetDistancePercent = params.targetProfitPercent
  const expectedMovePercent =
    params.atr !== undefined ? round2((params.atr / params.entryPrice) * 100) : undefined

  const rrPass = riskRewardRatio >= minRR
  reasons.push(rrPass ? `R:R ${riskRewardRatio} meets minimum ${minRR}` : `R:R ${riskRewardRatio} below minimum ${minRR}`)

  const tpPass = targetDistancePercent <= tpDistancePercent
  reasons.push(
    tpPass
      ? `target ${targetDistancePercent}% within TP distance ${tpDistancePercent}%`
      : `target ${targetDistancePercent}% beyond TP distance ${tpDistancePercent}%`
  )

  let atrPass = true
  if (params.atr !== undefined && expectedMovePercent !== undefined) {
    atrPass = targetDistancePercent <= 3 * expectedMovePercent
    reasons.push(
      atrPass
        ? `target ${targetDistancePercent}% within 3x ATR ${3 * expectedMovePercent}%`
        : `target ${targetDistancePercent}% exceeds 3x ATR ${3 * expectedMovePercent}%`
    )
  }

  return {
    feasible: rrPass && tpPass && atrPass,
    riskRewardRatio,
    breakEvenWinRate,
    expectedMovePercent,
    reasons,
  }
}
