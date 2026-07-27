import type { ToolRegistry } from "../types"
import { registerTools } from "../registry"
import { getFearGreed } from "./altme"
import { getGlobalMarket, getAssetMomentum } from "./alternativeme"
import { getTrendingCoins, getCoinSentiment, getCategoryPerformance, getGlobalSentiment } from "./coingecko"

export function buildSentimentRegistry(): ToolRegistry {
  const registry: ToolRegistry = {}
  registerTools(registry, [
    getFearGreed,
    getGlobalMarket,
    getAssetMomentum,
    getTrendingCoins,
    getCoinSentiment,
    getCategoryPerformance,
    getGlobalSentiment,
  ])
  return registry
}
