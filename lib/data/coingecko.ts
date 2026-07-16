import { withTimeout, withRetry } from "@/lib/utils"

const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"

export interface PriceData {
  usd: number
  change24h: number | null
}

export interface TrendingCoin {
  id: string
  symbol: string
  name: string
  marketCapRank: number | null
}

export interface Metadata {
  marketCap: number | null
  volume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  ath: number | null
  athChange: number | null
  description: string | null
}

/**
 * @function apiGet
 * @description Generic GET request with 15s timeout and up to 2 retries on failure.
 * HTTP errors (non-2xx) return null without retry. Network/timeout errors retry.
 * @param {string} url - Full URL to fetch.
 * @returns {Promise<T | null>} Parsed JSON response or null on failure.
 */
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

export async function fetchPrice(id: string): Promise<PriceData | null> {
  const url = `${BASE}/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`
  const data = await apiGet<Record<string, { usd: number; usd_24h_change?: number }>>(url)
  if (!data) return null
  const coin = data[id]
  if (!coin) return null
  return { usd: coin.usd, change24h: coin.usd_24h_change ?? null }
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

export async function fetchMetadata(id: string): Promise<Metadata> {
  const url = `${BASE}/coins/${id}?localization=false&tickers=false&community_data=true&developer_data=true`
  const data = await apiGet<{
    market_data?: {
      market_cap?: { usd?: number }
      total_volume?: { usd?: number }
      circulating_supply?: number | null
      total_supply?: number | null
      ath?: { usd?: number }
      ath_change_percentage?: { usd?: number }
    }
    description?: { en?: string | null }
  }>(url)
  if (!data) {
    return {
      marketCap: null,
      volume24h: null,
      circulatingSupply: null,
      totalSupply: null,
      ath: null,
      athChange: null,
      description: null,
    }
  }
  const md = data.market_data
  return {
    marketCap: md?.market_cap?.usd ?? null,
    volume24h: md?.total_volume?.usd ?? null,
    circulatingSupply: md?.circulating_supply ?? null,
    totalSupply: md?.total_supply ?? null,
    ath: md?.ath?.usd ?? null,
    athChange: md?.ath_change_percentage?.usd ?? null,
    description: data.description?.en ?? null,
  }
}
