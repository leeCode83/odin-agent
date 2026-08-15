/**
 * @file planning/compute-trade-numbers.ts
 * @description Single deterministic source of truth for all money numbers in a
 *   trade: entry price, stop-loss, take-profit, position size, and leverage.
 *   Pure function, no I/O, no LLM — every number is computed from tool results
 *   (get_mark_price / compute_sltp / compute_position_size) and the risk
 *   engine. When any required input is missing or invalid the function returns
 *   `{ no_trade: true, reason }` — there is NO fallback number path, so an
 *   LLM-guessed value can never survive into a trade plan.
 * @module planning
 * @layer service
 */

import { computeLeverage } from "@/lib/agent/shared/risk-engine"

/**
 * @interface ComputeTradeNumbersParams
 * @description Inputs to computeTradeNumbers. `markPrice`, `atr`, `equity`,
 *   `confidence`, `side`, and `thresholds` are inputs to the leverage/entry
 *   math; `sltpResult` and `positionSizeResult` are the raw successful tool
 *   outputs and are used verbatim (never recomputed, never capped).
 * @property {number | undefined} markPrice - Last successful get_mark_price result.
 * @property {number | undefined} atr - Last successful compute_atr result.
 * @property {{ stopLoss: number, takeProfit: number } | undefined} sltpResult - compute_sltp tool output.
 * @property {{ positionSizeUsdc: number } | undefined} positionSizeResult - compute_position_size tool output.
 * @property {{ max_leverage: number } | undefined} thresholds - Risk thresholds (only max_leverage is consumed).
 * @property {number | undefined} equity - Account equity in USDC.
 * @property {"long" | "short" | undefined} side - Position side.
 * @property {number | undefined} confidence - Post-DD confidence, 0..1 scale
 *   (matches computeLeverage; /100 the 0..100 aggregation confidence).
 */
export interface ComputeTradeNumbersParams {
  markPrice: number | undefined
  atr: number | undefined
  sltpResult: { stopLoss: number; takeProfit: number } | undefined
  positionSizeResult: { positionSizeUsdc: number } | undefined
  thresholds: { max_leverage: number } | undefined
  equity: number | undefined
  side: "long" | "short" | undefined
  confidence: number | undefined
}

/**
 * @type ComputeTradeNumbersResult
 * @description Success carries the deterministic trade numbers; failure carries
 *   a human-readable reason for the forced no_trade. No third state exists.
 */
export type ComputeTradeNumbersResult =
  | { entry: number; stopLoss: number; takeProfit: number; positionSizeUsdc: number; leverage: number }
  | { no_trade: true; reason: string }

/**
 * @function round2
 * @description Rounds a number to 2 decimal places, matching the risk-engine
 *   output style.
 * @param {number} n - Value to round.
 * @returns {number} Rounded value.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * @function isPositiveNumber
 * @description True when the value is a finite number greater than 0. Guard for
 *   inputs the math cannot tolerate (entry, ATR, equity, max leverage).
 * @param {number | undefined} x - Value to test.
 * @returns {boolean} True when finite and positive.
 */
function isPositiveNumber(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0
}

/**
 * @function isFiniteNumber
 * @description True when the value is a finite number. Guard for computed
 *   outputs (SL/TP/size), which may legitimately be 0 or negative — the
 *   contract forbids adding caps the repo does not already have.
 * @param {number | undefined} x - Value to test.
 * @returns {boolean} True when finite.
 */
function isFiniteNumber(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x)
}

/**
 * @function noTrade
 * @description Builds a no_trade result.
 * @param {string} reason - Human-readable failure reason.
 * @returns {ComputeTradeNumbersResult} Forced no_trade result.
 */
function noTrade(reason: string): ComputeTradeNumbersResult {
  return { no_trade: true, reason }
}

/**
 * @function computeTradeNumbers
 * @description Computes every money number for a trade deterministically:
 *
 *   1. entry = mark price (get_mark_price result)
 *   2. stopLoss / takeProfit = compute_sltp result verbatim (ATR-based)
 *   3. positionSizeUsdc = compute_position_size result verbatim
 *   4. leverage = computeLeverage(entry, atr, confidence, max_leverage)
 *
 *   Any required input missing or invalid (non-finite, non-positive where the
 *   math needs it) → `{ no_trade: true, reason }`. No fallback numbers, ever.
 *   Outputs are rounded to 2 decimals to match risk-engine style; no new caps
 *   are applied to SL/TP/size.
 * @param {ComputeTradeNumbersParams} params - All deterministic inputs.
 * @returns {ComputeTradeNumbersResult} Trade numbers or a forced no_trade.
 */
export function computeTradeNumbers(params: ComputeTradeNumbersParams): ComputeTradeNumbersResult {
  const { markPrice, atr, sltpResult, positionSizeResult, thresholds, equity, side, confidence } = params

  if (side !== "long" && side !== "short") {
    return noTrade(`invalid side: ${String(side)}`)
  }
  if (!isPositiveNumber(markPrice)) {
    return noTrade("no valid mark price (get_mark_price required)")
  }
  if (!isPositiveNumber(atr)) {
    return noTrade("no valid ATR (compute_atr required)")
  }
  if (sltpResult === undefined || !isFiniteNumber(sltpResult.stopLoss) || !isFiniteNumber(sltpResult.takeProfit)) {
    return noTrade("no valid compute_sltp result")
  }
  if (positionSizeResult === undefined || !isFiniteNumber(positionSizeResult.positionSizeUsdc)) {
    return noTrade("no valid position size (compute_position_size required)")
  }
  if (!isPositiveNumber(equity)) {
    return noTrade("no valid equity")
  }
  if (!isFiniteNumber(confidence)) {
    return noTrade("no valid confidence")
  }
  if (thresholds === undefined || !isPositiveNumber(thresholds.max_leverage)) {
    return noTrade("no valid risk thresholds (max_leverage required)")
  }

  const entry = round2(markPrice)
  const leverage = computeLeverage({
    entry,
    atr,
    confidence,
    maxLeverage: thresholds.max_leverage,
  })
  if (!isFiniteNumber(leverage)) {
    return noTrade("leverage computation failed")
  }

  return {
    entry,
    stopLoss: round2(sltpResult.stopLoss),
    takeProfit: round2(sltpResult.takeProfit),
    positionSizeUsdc: round2(positionSizeResult.positionSizeUsdc),
    leverage,
  }
}
