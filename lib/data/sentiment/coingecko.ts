import { withTimeout, withRetry } from "@/lib/utils"

const BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"
const API_KEY = process.env.COINGECKO_API_KEY || ""

function headers(): Record<string, string> {
  return API_KEY ? { "x-cg-demo-api-key": API_KEY } : {}
}

export async function fetchTrendingCoins() {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${BASE}/search/trending`, { headers: headers() }), 15_000)
      if (!res.ok) return null
      return res.json()
    },
    { retries: 2 }
  ).catch(() => null)
}

export async function fetchCoinData(coinId: string) {
  return withRetry(
    async () => {
      const res = await withTimeout(
        fetch(`${BASE}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=true&developer_data=false`, { headers: headers() }),
        15_000
      )
      if (!res.ok) return null
      return res.json()
    },
    { retries: 2 }
  ).catch(() => null)
}

export async function fetchCategoryPerformance() {
  return withRetry(
    async () => {
      const res = await withTimeout(
        fetch(`${BASE}/coins/categories?order=market_cap_change_percentage_24h_desc`, { headers: headers() }),
        15_000
      )
      if (!res.ok) return null
      return res.json()
    },
    { retries: 2 }
  ).catch(() => null)
}

export async function fetchGlobalData() {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${BASE}/global`, { headers: headers() }), 15_000)
      if (!res.ok) return null
      return res.json()
    },
    { retries: 2 }
  ).catch(() => null)
}
