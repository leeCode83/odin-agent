import { fetchFearGreedIndex } from "./altme"
import { fetchTrending, fetchGlobalSentiment } from "./coingecko"

/**
 * @interface SentimentOutput
 * @description Standardized output for sentiment data.
 */
export interface SentimentOutput {
  fearGreedIndex: number | null
  fearGreedClassification: string | null
  trendingRank: number | null
}

/**
 * @function fetchSentimentData
 * @description Orchestrates fetching of sentiment data, prioritizing Alternative.me and falling back to CoinGecko.
 * @returns {Promise<SentimentOutput>} Standardized sentiment data.
 */
export async function fetchSentimentData(): Promise<SentimentOutput> {
  const [fgData, trending] = await Promise.all([
    (async () => {
      const primary = await fetchFearGreedIndex().catch(() => null)
      if (primary && primary.value !== null) return primary
      console.log("[Sentiment] Alt.me unavailable, trying CoinGecko global")
      const fallback = await fetchGlobalSentiment().catch(() => null)
      if (fallback) console.log("[Sentiment] Using CoinGecko global sentiment")
      return fallback
    })(),
    fetchTrending(),
  ])

  return {
    fearGreedIndex: fgData?.value ?? null,
    fearGreedClassification: fgData?.classification ?? null,
    trendingRank: trending.length > 0 ? 1 : null,
  }
}
