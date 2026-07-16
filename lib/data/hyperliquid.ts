import { HttpTransport, InfoClient } from "@nktkas/hyperliquid"
import type { CandleData, OnchainData } from "./types"
import { withTimeout, withRetry } from "@/lib/utils"

/**
 * @function createHLClient
 * @description Creates a Hyperliquid InfoClient. Reads HYPERLIQUID_TESTNET env var
 * (defaults to true if unset or "true").
 * @returns {InfoClient} Hyperliquid InfoClient instance.
 */
export function createHLClient(): InfoClient {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
  const transport = new HttpTransport({ isTestnet })
  return new InfoClient({ transport })
}

/**
 * @function fetchCandles
 * @description Fetches 1h OHLCV candles from Hyperliquid with 15s timeout.
 * @param {InfoClient} client - Hyperliquid InfoClient.
 * @param {string} asset - Asset ticker (e.g. "BTC").
 * @returns {Promise<CandleData[]>} Array of candle data.
 */
export async function fetchCandles(client: InfoClient, asset: string): Promise<CandleData[]> {
  const now = Date.now()
  const window = 72 * 60 * 60 * 1000
  const candles = await withTimeout(
    client.candleSnapshot({
      coin: asset,
      interval: "1h",
      startTime: now - window,
      endTime: now,
    }),
    15_000
  )
  return candles.map((c) => ({
    timestamp: c.t,
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  }))
}

/**
 * @function fetchOnchainData
 * @description Fetches on-chain data (funding rate, OI, mark price) from Hyperliquid
 * with 15s timeout per SDK call.
 * @param {InfoClient} client - Hyperliquid InfoClient.
 * @param {string} asset - Asset ticker.
 * @returns {Promise<OnchainData>} On-chain data object.
 */
export async function fetchOnchainData(client: InfoClient, asset: string): Promise<OnchainData> {
  const now = Date.now()
  const [meta, assetCtxs] = await withTimeout(client.metaAndAssetCtxs(), 15_000)
  const idx = meta.universe.findIndex((u) => u.name === asset)
  const ctx = idx >= 0 ? assetCtxs[idx] : null

  await withTimeout(client.fundingHistory({ coin: asset, startTime: now - 72 * 60 * 60 * 1000, endTime: now }), 15_000)
  const oiCapList = await withTimeout(client.perpsAtOpenInterestCap(), 15_000)

  return {
    fundingRate: ctx ? parseFloat(ctx.funding) : 0,
    openInterest: ctx ? parseFloat(ctx.openInterest) : 0,
    markPrice: ctx ? parseFloat(ctx.markPx) : 0,
    oraclePrice: ctx ? parseFloat(ctx.oraclePx) : 0,
    premium: ctx ? (ctx.premium !== null ? parseFloat(ctx.premium) : null) : null,
    dayVolume: ctx ? parseFloat(ctx.dayNtlVlm) : 0,
    oiCapReached: oiCapList.includes(asset),
  }
}

/**
 * @function fetchCandlesByInterval
 * @description Fetches OHLCV candles for a custom interval with 15s timeout.
 * @param {InfoClient} client - Hyperliquid InfoClient.
 * @param {string} asset - Asset ticker.
 * @param {string} interval - Candle interval ("1h", "15m", "1d", etc.).
 * @param {number} startTime - Start timestamp in ms.
 * @param {number} endTime - End timestamp in ms.
 * @returns {Promise<CandleData[]>} Array of candle data.
 */
async function fetchCandlesByInterval(
  client: InfoClient,
  asset: string,
  interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M",
  startTime: number,
  endTime: number
): Promise<CandleData[]> {
  const candles = await withTimeout(
    client.candleSnapshot({ coin: asset, interval, startTime, endTime }),
    15_000
  )
  return candles.map((c: any) => ({
    timestamp: c.t,
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  }))
}

/**
 * @function fetchAllHLData
 * @description Fetches all Hyperliquid data (candles 1h/15m/1d + on-chain) in parallel
 * with per-call retry (up to 3 attempts each). Failed sub-calls retry independently
 * without affecting parallel siblings.
 * @param {string} asset - Asset ticker.
 * @returns {Promise<{candles1h: CandleData[], candles15m: CandleData[], candles1d: CandleData[], currentPrice: number, priceChange24h: number, onchain: OnchainData}>}
 */
export async function fetchAllHLData(asset: string): Promise<{
  candles1h: CandleData[]
  candles15m: CandleData[]
  candles1d: CandleData[]
  currentPrice: number
  priceChange24h: number
  onchain: OnchainData
}> {
  const client = createHLClient()
  const now = Date.now()
  const [candles1h, candles15m, candles1d, onchain] = await Promise.all([
    withRetry(() => fetchCandles(client, asset), { retries: 2 }),
    withRetry(() => fetchCandlesByInterval(client, asset, "15m", now - 24 * 60 * 60 * 1000, now), { retries: 2 }),
    withRetry(() => fetchCandlesByInterval(client, asset, "1d", now - 30 * 24 * 60 * 60 * 1000, now), { retries: 2 }),
    withRetry(() => fetchOnchainData(client, asset), { retries: 2 }),
  ])
  const currentPrice = candles1h.length > 0 ? candles1h[candles1h.length - 1].close : 0
  const priceChange24h = candles1d.length >= 2
    ? ((candles1d[candles1d.length - 1].close - candles1d[candles1d.length - 2].close) / candles1d[candles1d.length - 2].close) * 100
    : 0
  return { candles1h, candles15m, candles1d, currentPrice, priceChange24h, onchain }
}
