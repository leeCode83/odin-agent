import type { Side } from "@/lib/agent/types"
import type { CandleData } from "@/lib/data/types"
import { createHLClient, fetchOnchainData } from "@/lib/data/hyperliquid"

/**
 * @function computeATR
 * @description Computes Average True Range (ATR) from candle data.
 * Candles sorted ascending by timestamp (earliest first).
 * @param {CandleData[]} candles - OHLCV candle array.
 * @param {number} period - ATR smoothing period (default 14).
 * @returns {number} Final ATR value, 0 if insufficient data.
 */
export function computeATR(candles: CandleData[], period: number = 14): number {
  if (candles.length === 0 || candles.length < period + 1) {
    throw new Error(`Insufficient candles for ATR(${period}): got ${candles.length}, need at least ${period + 1}`)
  }

  // Compute true range for each candle starting from index 1
  const trueRanges: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    )
    trueRanges.push(tr)
  }

  // First ATR = simple average of first `period` true ranges
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period

  // Subsequent ATRs use exponential-style smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period
  }

  if (atr === 0) {
    throw new Error("ATR is zero — cannot compute meaningful SL/TP")
  }

  return atr
}

/**
 * @function computeSLTP
 * @description Computes stop-loss and take-profit levels from entry, ATR, and side.
 * Uses configurable ATR multipliers for risk/reward ratio.
 * @param {number} entry - Entry price.
 * @param {number} atr - Current ATR value.
 * @param {Side} side - "long" or "short".
 * @param {object} [options] - Optional multiplier overrides.
 * @param {number} [options.slMultiplier=1.5] - ATR multiplier for stop-loss.
 * @param {number} [options.tpMultiplier=3.0] - ATR multiplier for take-profit.
 * @returns {{ stopLoss: number, takeProfit: number }} Rounded to 2 decimals.
 */
export function computeSLTP(
  entry: number,
  atr: number,
  side: Side,
  options?: { slMultiplier?: number; tpMultiplier?: number }
): { stopLoss: number; takeProfit: number } {
  const slMult = options?.slMultiplier ?? 1.5
  const tpMult = options?.tpMultiplier ?? 3.0

  if (side === "long") {
    return {
      stopLoss: Math.round((entry - atr * slMult) * 100) / 100,
      takeProfit: Math.round((entry + atr * tpMult) * 100) / 100,
    }
  }

  // short: SL above entry, TP below entry
  return {
    stopLoss: Math.round((entry + atr * slMult) * 100) / 100,
    takeProfit: Math.round((entry - atr * tpMult) * 100) / 100,
  }
}

/**
 * @function computePositionSize
 * @description Computes position size in USDC value and contracts based on
 * account equity, entry price, stop-loss, and risk percentage.
 * @param {number} equity - Account equity in USDC.
 * @param {number} entry - Entry price in USDC.
 * @param {number} stopLoss - Stop-loss price in USDC.
 * @param {number} riskPercent - Percentage of equity to risk (0-100).
 * @returns {{ positionSizeUsdc: number, positionSizeContracts: number }}
 *   Zero if price risk is 0 (entry equals stop-loss).
 */
export function computePositionSize(
  equity: number,
  entry: number,
  stopLoss: number,
  riskPercent: number
): { positionSizeUsdc: number; positionSizeContracts: number } {
  const riskAmount = equity * (riskPercent / 100)
  const priceRisk = Math.abs(entry - stopLoss)

  if (priceRisk === 0) {
    return { positionSizeUsdc: 0, positionSizeContracts: 0 }
  }

  const contracts = riskAmount / priceRisk
  const positionSizeUsdc = contracts * entry

  return {
    positionSizeUsdc: Math.round(positionSizeUsdc * 100) / 100,
    positionSizeContracts: Math.round(contracts * 10000) / 10000,
  }
}

/**
 * @function capLeverage
 * @description Caps LLM-suggested leverage to max allowed value.
 * @param {number} llmSuggested - Leverage suggested by the LLM.
 * @param {number} maxAllowed - Maximum leverage allowed by risk thresholds.
 * @returns {number} Capped leverage, rounded to 1 decimal place.
 */
export function capLeverage(llmSuggested: number, maxAllowed: number): number {
  return Math.round(Math.min(llmSuggested, maxAllowed) * 10) / 10
}

/**
 * @function computeEntryPrice
 * @description Fetches current mark price from Hyperliquid.
 * Delegates to the HL SDK via fetchOnchainData.
 * @param {string} asset - Asset ticker (e.g. "BTC").
 * @returns {Promise<number>} Current mark price, 0 on failure.
 */
export async function computeEntryPrice(asset: string): Promise<number> {
  try {
    const client = createHLClient()
    const onchain = await fetchOnchainData(client, asset)
    return onchain.markPrice
  } catch {
    return 0
  }
}
