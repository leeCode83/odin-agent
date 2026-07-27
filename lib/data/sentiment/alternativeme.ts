import { withTimeout, withRetry } from "@/lib/utils"
import type { GlobalMarketData, AssetMomentumData } from "@/lib/data/types"

const BASE = process.env.ALTERNATIVE_ME_BASE_URL || "https://api.alternative.me"

export async function fetchGlobalMarket(): Promise<GlobalMarketData> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${BASE}/v2/global/`), 15_000)
      if (!res.ok) return { total_market_cap: null, total_volume_24h: null }
      const json = await res.json() as { data?: { market_cap_usd: number; total_volume_usd: number } }
      return {
        total_market_cap: json.data?.market_cap_usd ?? null,
        total_volume_24h: json.data?.total_volume_usd ?? null,
      }
    },
    { retries: 2 }
  ).catch(() => ({ total_market_cap: null, total_volume_24h: null }))
}

export async function fetchAssetMomentum(id: number): Promise<AssetMomentumData> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${BASE}/v2/ticker/${id}/`), 15_000)
      if (!res.ok) return { price_usd: null, percent_change_1h: null, percent_change_24h: null, percent_change_7d: null, volume_24h_usd: null }
      const json = await res.json() as { data?: { price_usd: number; percent_change_1h: number; percent_change_24h: number; percent_change_7d: number; volume_24h_usd: number } }
      return {
        price_usd: json.data?.price_usd ?? null,
        percent_change_1h: json.data?.percent_change_1h ?? null,
        percent_change_24h: json.data?.percent_change_24h ?? null,
        percent_change_7d: json.data?.percent_change_7d ?? null,
        volume_24h_usd: json.data?.volume_24h_usd ?? null,
      }
    },
    { retries: 2 }
  ).catch(() => ({ price_usd: null, percent_change_1h: null, percent_change_24h: null, percent_change_7d: null, volume_24h_usd: null }))
}
