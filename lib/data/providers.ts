import { fetchAllHLData } from "@/lib/data/hyperliquid"
import { fetchTechnicalData } from "@/lib/data/technical"
import { fetchOnchainData } from "@/lib/data/onchain"
import { fetchSentimentData } from "@/lib/data/sentiment"
import { fetchFundamentalData } from "@/lib/data/fundamental"
import { getCoinGeckoId } from "@/lib/asset-categories"
import type { CategoryConfig } from "@/lib/asset-categories"

interface RawFactorTechnical {
  candles1h: import("@/lib/data/types").CandleData[]
  candles15m: import("@/lib/data/types").CandleData[]
  candles1d: import("@/lib/data/types").CandleData[]
  currentPrice: number
  priceChange24h: number
}

interface RawFactorOnchain {
  fundingRate: number
  openInterest: number
  markPrice: number
  oraclePrice: number
  premium: number | null
  dayVolume: number
  oiCapReached: boolean
}

interface RawFactorSentiment {
  fearGreedIndex: number | null
  fearGreedClassification: string | null
  trendingRank: number | null
}

interface RawFactorFundamental {
  marketCap: number | null
  totalVolume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  athPrice: number | null
  athChangePercent: number | null
  description: string | null
}

export interface RawFactorData {
  technical: RawFactorTechnical | null
  onchain: RawFactorOnchain | null
  sentiment: RawFactorSentiment | null
  fundamental: RawFactorFundamental | null
}

export async function fetchAllRawData(asset: string, category: CategoryConfig): Promise<RawFactorData> {
  const active = new Set(category.activeFactors)
  const cgId = getCoinGeckoId(asset)

  const hlData = active.has("technical") || active.has("onchain")
    ? await fetchAllHLData(asset).catch(() => null)
    : null

  const [technical, onchain, sentiment, fundamental] = await Promise.all([
    active.has("technical")
      ? fetchTechnicalData(asset, hlData ? {
          candles1h: hlData.candles1h, candles15m: hlData.candles15m, candles1d: hlData.candles1d,
          currentPrice: hlData.currentPrice, priceChange24h: hlData.priceChange24h,
        } : null)
      : Promise.resolve(null),
    active.has("onchain")
      ? fetchOnchainData(asset, hlData?.onchain ?? null)
      : Promise.resolve(null),
    active.has("sentiment")
      ? fetchSentimentData()
      : Promise.resolve(null),
    cgId && active.has("fundamental")
      ? fetchFundamentalData(cgId, asset)
      : Promise.resolve(null),
  ])

  return { technical, onchain, sentiment, fundamental }
}
