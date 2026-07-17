/**
 * @file coingecko.ts
 * @description CoinGecko OHLC data fetcher for technical analysis fallback.
 * Fetches daily OHLC data via CoinGecko keyless API when Hyperliquid candles
 * are unavailable. Returns CandleData[] without volume data.
 * @module technical
 * @layer data
 */

import { withTimeout, withRetry } from "@/lib/utils"
import type { CandleData } from "@/lib/data/types"

const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"

const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", SUI: "sui",
  AVAX: "avalanche-2", UNI: "uniswap", AAVE: "aave", LINK: "chainlink",
  DOGE: "dogecoin", PEPE: "pepe", WIF: "dogwifcoin",
}

type OHLCData = [number, number, number, number, number]

async function fetchOHLC(id: string, days: 1 | 7 | 30): Promise<OHLCData[] | null> {
  return withRetry(
    async () => {
      const res = await withTimeout(
        fetch(`${BASE}/coins/${id}/ohlc?vs_currency=usd&days=${days}`),
        15_000
      )
      if (!res.ok) return null
      const data = (await res.json()) as OHLCData[]
      return Array.isArray(data) ? data : null
    },
    { retries: 2 }
  ).catch(() => null)
}

function toCandleData(d: OHLCData): CandleData {
  return {
    timestamp: d[0],
    open: d[1],
    high: d[2],
    low: d[3],
    close: d[4],
    volume: 0,
  }
}

export async function fetchCoinGeckoOHLC(asset: string): Promise<{
  candles1h: CandleData[]
  candles15m: CandleData[]
  candles1d: CandleData[]
  currentPrice: number
  priceChange24h: number
} | null> {
  const ticker = asset.toUpperCase()
  const id = COINGECKO_ID[ticker]
  if (!id) return null

  // days=1 gives ~30min candles (closest to 1h), days=7 gives ~4h candles (daily proxy)
  const [shortTerm, mediumTerm] = await Promise.all([
    fetchOHLC(id, 1),
    fetchOHLC(id, 7),
  ])

  if (!shortTerm && !mediumTerm) return null

  const candles1h = shortTerm ? shortTerm.map(toCandleData) : []
  const candles1d = mediumTerm ? mediumTerm.map(toCandleData) : []

  const latestCandle = candles1h.length > 0
    ? candles1h[candles1h.length - 1]
    : candles1d.length > 0
      ? candles1d[candles1d.length - 1]
      : null

  if (!latestCandle) return null

  const currentPrice = latestCandle.close
  const priceChange24h = candles1h.length > 1
    ? ((candles1h[candles1h.length - 1].close - candles1h[0].open) / candles1h[0].open) * 100
    : 0

  return { candles1h, candles15m: [], candles1d, currentPrice, priceChange24h }
}
