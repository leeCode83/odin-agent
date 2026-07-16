import { fetchAllHLData } from "@/lib/data/hyperliquid"
import { fetchMetadata, fetchTrending } from "@/lib/data/coingecko"
import { fetchFearGreedIndex } from "@/lib/data/sentiment"
import { getCoinGeckoId } from "@/lib/asset-categories"
import type { CategoryConfig } from "@/lib/asset-categories"
import type { CandleData } from "@/lib/data/types"

interface RawFactorTechnical {
  candles1h: CandleData[]
  candles15m: CandleData[]
  candles1d: CandleData[]
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

  const hlPromise = active.has("technical") || active.has("onchain")
    ? fetchAllHLData(asset).catch(() => null)
    : Promise.resolve(null)

  const metadataPromise = cgId && active.has("fundamental")
    ? fetchMetadata(cgId)
    : Promise.resolve(null)

  const trendingPromise = active.has("sentiment")
    ? fetchTrending()
    : Promise.resolve(null)

  const fgPromise = active.has("sentiment")
    ? fetchFearGreedIndex()
    : Promise.resolve(null)

  const [hlData, metadataData, trendingData, fgData] = await Promise.all([
    hlPromise, metadataPromise, trendingPromise, fgPromise,
  ])

  return {
    technical: hlData
      ? { candles1h: hlData.candles1h, candles15m: hlData.candles15m, candles1d: hlData.candles1d, currentPrice: hlData.currentPrice, priceChange24h: hlData.priceChange24h }
      : null,
    onchain: hlData ? hlData.onchain : null,
    sentiment: fgData ? { fearGreedIndex: fgData.value, fearGreedClassification: fgData.classification, trendingRank: trendingData ? 1 : null } : null,
    fundamental: metadataData ? {
      marketCap: metadataData.marketCap,
      totalVolume24h: metadataData.volume24h,
      circulatingSupply: metadataData.circulatingSupply,
      totalSupply: metadataData.totalSupply,
      athPrice: metadataData.ath,
      athChangePercent: metadataData.athChange,
      description: metadataData.description,
    } : null,
  }
}
