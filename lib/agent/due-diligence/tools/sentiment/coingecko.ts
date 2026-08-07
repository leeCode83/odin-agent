import { z } from "zod"
import { fetchTrendingCoins, fetchCoinData, fetchCategoryPerformance, fetchGlobalData } from "@/lib/data/sentiment/coingecko"
import type { ToolDefinition } from "../types"

export const getTrendingCoins: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_trending_coins",
  description: "Fetches the top 15 trending coins from CoinGecko to identify narrative heat and market attention.",
  parameters: z.object({}),
  execute: async () => {
    const start = Date.now()
    try {
      const data = await fetchTrendingCoins()
      return {
        success: true,
        data,
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    }
  },
}

export const getCoinSentiment: ToolDefinition<
  z.ZodObject<{ coinId: z.ZodString }>
> = {
  name: "get_coin_sentiment",
  description: "Fetches community sentiment votes (up/down %) and market data for a specific coin from CoinGecko.",
  parameters: z.object({ coinId: z.string().describe("CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'avalanche-2')") }),
  execute: async (params) => {
    const start = Date.now()
    try {
      const data = await fetchCoinData(params.coinId)
      return {
        success: true,
        data,
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    }
  },
}

export const getCategoryPerformance: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_category_performance",
  description: "Fetches crypto category performance sorted by 24h market cap change to identify sector rotation trends.",
  parameters: z.object({}),
  execute: async () => {
    const start = Date.now()
    try {
      const data = await fetchCategoryPerformance()
      return {
        success: true,
        data,
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    }
  },
}

export const getGlobalSentiment: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_global_sentiment",
  description: "Fetches global crypto market data (BTC dominance, total market cap changes) from CoinGecko for macro risk appetite assessment.",
  parameters: z.object({}),
  execute: async () => {
    const start = Date.now()
    try {
      const data = await fetchGlobalData()
      return {
        success: true,
        data,
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    }
  },
}
