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

/**
 * @constant CoinSentimentDataSchema
 * @description Structured get_coin_sentiment output consumed by deterministic scoring:
 *   upPercent (community up-vote share 0-100) drives the crowd-sentiment signal.
 */
export const CoinSentimentDataSchema = z.object({
  coinId: z.string(),
  votesUp: z.number().nullable(),
  votesDown: z.number().nullable(),
  upPercent: z.number().nullable(),
  downPercent: z.number().nullable(),
})

/** @typedef {z.infer<typeof CoinSentimentDataSchema>} CoinSentimentData */
export type CoinSentimentData = z.infer<typeof CoinSentimentDataSchema>

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
      const community = (data?.community_data ?? {}) as Record<string, unknown>
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
      return {
        success: true,
        data: {
          coinId: params.coinId,
          votesUp: num(community.votes_up),
          votesDown: num(community.votes_down),
          upPercent: num(community.sentiment_votes_up_percentage),
          downPercent: num(community.sentiment_votes_down_percentage),
        },
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
