import { withTimeout, withRetry } from "@/lib/utils"

const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"

interface Metadata {
  marketCap: number | null
  volume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  ath: number | null
  athChange: number | null
  description: string | null
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
