/**
 * @file tools/technical/candles.ts
 * @description Candle pre-fetch module for technical analysis tools. Fetches OHLCV data
 * across 3 timeframes (1h, 15m, 1d) in parallel for use by indicator computations.
 * @module tools/technical
 * @layer util
 */

import { createHLClient, fetchCandlesByInterval } from "@/lib/data/hyperliquid"
import type { CandleData } from "@/lib/data/types"

/**
 * @typedef CandleMap
 * @description Record of candle arrays keyed by timeframe string (e.g. "1h", "15m", "1d").
 */
export interface CandleMap {
  [timeframe: string]: CandleData[]
}

/**
 * @constant TIMEFRAMES
 * @description Timeframe configurations: interval string, candle count, and lookback window in ms.
 */
const TIMEFRAMES = [
  { key: "1h", candles: 200, window: 200 * 3_600_000 },
  { key: "15m", candles: 200, window: 200 * 900_000 },
  { key: "1d", candles: 100, window: 100 * 86_400_000 },
] as const

/**
 * @function fetchCandleMap
 * @description Fetches OHLCV candles for 3 timeframes (1h, 15m, 1d) in parallel.
 * Non-fatal: if a timeframe fetch fails, it returns an empty array for that key.
 * @param {string} asset - Asset ticker (e.g. "BTC").
 * @returns {Promise<CandleMap>} CandleMap with keys "1h", "15m", "1d".
 */
export async function fetchCandleMap(asset: string): Promise<CandleMap> {
  const client = createHLClient()
  const now = Date.now()

  const results = await Promise.allSettled(
    TIMEFRAMES.map((tf) =>
      fetchCandlesByInterval(
        client,
        asset,
        tf.key as "1h" | "15m" | "1d",
        now - tf.window,
        now
      ).then((candles) => ({ key: tf.key, candles }))
    )
  )

  const map: CandleMap = {}
  for (const result of results) {
    if (result.status === "fulfilled") {
      map[result.value.key] = result.value.candles
    } else {
      console.warn(`[candles] Failed to fetch timeframe: ${result.reason}`)
    }
  }

  TIMEFRAMES.forEach((tf) => {
    if (!map[tf.key]) map[tf.key] = []
  })

  return map
}

/**
 * @function getTimeframeCandles
 * @description Returns candle data for a given timeframe from a CandleMap.
 * Returns empty array if the timeframe is not present in the map.
 * @param {string} timeframe - The timeframe key (e.g. "1h", "15m", "1d").
 * @param {CandleMap} candleMap - Map of timeframe to candle arrays.
 * @returns {CandleData[]} Candle array for the timeframe, or empty array.
 */
export function getTimeframeCandles(timeframe: string, candleMap: CandleMap): CandleData[] {
  return candleMap[timeframe] ?? []
}
