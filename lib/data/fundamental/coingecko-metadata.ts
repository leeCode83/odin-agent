import { withTimeout, withRetry } from "@/lib/utils"

/**
 * @constant BASE
 * @description Base URL for CoinGecko API.
 */
const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"

/**
 * @interface Metadata
 * @description Represents the fundamental metadata retrieved from CoinGecko.
 */
interface Metadata {
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
 * @description Helper function to perform GET requests with retry and timeout.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<T | null>} The parsed JSON response or null on failure.
 * @template T
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

/**
 * @function fetchMetadata
 * @description Fetches market and description metadata for a specific coin from CoinGecko.
 * @param {string} id - The CoinGecko ID of the asset.
 * @returns {Promise<Metadata>} An object containing market cap, supply, ATH, and description data.
 */
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
      marketCap: null, volume24h: null, circulatingSupply: null, totalSupply: null,
      ath: null, athChange: null, description: null,
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
