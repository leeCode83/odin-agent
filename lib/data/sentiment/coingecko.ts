/**
 * @file coingecko.ts
 * @description CoinGecko data fetchers for sentiment analysis. Provides
 * trending coins and market-wide Fear & Greed proxy (from global stats).
 * Replaces separate coingecko-trending.ts and coinmarketcap.ts.
 * @module sentiment
 * @layer data
 */

import { withTimeout, withRetry } from "@/lib/utils"
import type { FearGreedData } from "@/lib/data/fetch-utils"

const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"

interface TrendingCoin {
  id: string
  symbol: string
  name: string
  marketCapRank: number | null
}

interface CoinGeckoGlobal {
  data?: {
    market_cap_change_percentage_24h_usd: number
  }
}

async function apiGet<T>(url: string): Promise<T | null> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(url), 15_000)
      if (!res.ok) return null
      return (await res.json()) as T
    },
    { retries: 2 }
  ).catch(() => null)
}

function changeToFng(change24h: number): { value: number; classification: string } {
  const raw = ((change24h + 5) / 10) * 100
  const value = Math.max(0, Math.min(100, Math.round(raw)))

  let classification: string
  if (value >= 75) classification = "Extreme Greed"
  else if (value >= 55) classification = "Greed"
  else if (value >= 45) classification = "Neutral"
  else if (value >= 25) classification = "Fear"
  else classification = "Extreme Fear"

  return { value, classification }
}

export async function fetchTrending(): Promise<TrendingCoin[]> {
  const url = `${BASE}/search/trending`
  const data = await apiGet<{ coins: Array<{ item: { id: string; symbol: string; name: string; market_cap_rank?: number | null } }> }>(url)
  if (!data) return []
  return data.coins.map((c) => ({
    id: c.item.id,
    symbol: c.item.symbol,
    name: c.item.name,
    marketCapRank: c.item.market_cap_rank ?? null,
  }))
}

export async function fetchGlobalSentiment(): Promise<FearGreedData | null> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${BASE}/global`), 15_000)
      if (!res.ok) return null
      const json = (await res.json()) as CoinGeckoGlobal
      if (!json.data || json.data.market_cap_change_percentage_24h_usd === undefined) return null
      return changeToFng(json.data.market_cap_change_percentage_24h_usd)
    },
    { retries: 2 }
  ).catch(() => null)
}
