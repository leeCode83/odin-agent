/**
 * @file sentiment/cryptocurrencycv.ts
 * @description Cryptocurrency.cv API client tools — AI-powered market sentiment, narratives, trending topics,
 * Twitter sentiment, AI research, and news. Free tier: 100 requests per 15 minutes, no API key required.
 * @module tools/sentiment
 * @layer util
 */

import { z } from "zod"
import { withTimeout } from "@/lib/utils"
import type { ToolDefinition, ToolResult } from "../types"

const BASE_URL =
  process.env.CRYPTOCURRENCY_CV_BASE_URL || "https://api.cryptocurrency.cv"

async function executeFetch(url: string): Promise<ToolResult> {
  const start = Date.now()
  try {
    const res = await withTimeout(fetch(url), 15_000)
    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${res.status}`,
        metadata: { source: "cryptocurrency.cv", latencyMs: Date.now() - start },
      }
    }
    const data = await res.json()
    return {
      success: true,
      data,
      metadata: { source: "cryptocurrency.cv", latencyMs: Date.now() - start },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      metadata: { source: "cryptocurrency.cv", latencyMs: Date.now() - start },
    }
  }
}

/**
 * @function getAiSentiment
 * @description Fetches AI-powered market sentiment analysis from cryptocurrency.cv.
 * @returns {ToolResult} Sentiment analysis data.
 */
export const getAiSentiment: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_ai_sentiment",
  description: "Fetches AI-powered market sentiment analysis.",
  parameters: z.object({}),
  execute: async () => executeFetch(`${BASE_URL}/api/sentiment`),
}

/**
 * @function getNarratives
 * @description Fetches emerging narratives and thematic trends.
 * @returns {ToolResult} Narratives data.
 */
export const getNarratives: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_narratives",
  description: "Fetches emerging narratives and thematic trends.",
  parameters: z.object({}),
  execute: async () => executeFetch(`${BASE_URL}/api/narratives`),
}

/**
 * @function getTrendingTopics
 * @description Fetches trending coins and topics.
 * @returns {ToolResult} Trending topics data.
 */
export const getTrendingTopics: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_trending_topics",
  description: "Fetches trending coins and topics.",
  parameters: z.object({}),
  execute: async () => executeFetch(`${BASE_URL}/api/trending`),
}

/**
 * @function getTwitterSentiment
 * @description Fetches Twitter sentiment analysis, optionally for a specific coin.
 * @param {Object} params
 * @param {string} [params.coin] - Optional coin symbol to filter sentiment.
 * @returns {ToolResult} Twitter sentiment data.
 */
export const getTwitterSentiment: ToolDefinition<
  z.ZodObject<{ coin: z.ZodOptional<z.ZodString> }>
> = {
  name: "get_twitter_sentiment",
  description: "Fetches Twitter sentiment analysis, optionally for a specific coin.",
  parameters: z.object({ coin: z.string().optional() }),
  execute: async (params) => {
    const url = params.coin
      ? `${BASE_URL}/api/social/x/sentiment?coin=${encodeURIComponent(params.coin)}`
      : `${BASE_URL}/api/social/x/sentiment`
    return executeFetch(url)
  },
}

/**
 * @function getAiResearch
 * @description Fetches AI research on a given topic.
 * @param {Object} params
 * @param {string} params.topic - The research topic.
 * @returns {ToolResult} AI research data.
 */
export const getAiResearch: ToolDefinition<
  z.ZodObject<{ topic: z.ZodString }>
> = {
  name: "get_ai_research",
  description: "Fetches AI research on a given topic.",
  parameters: z.object({ topic: z.string() }),
  execute: async (params) =>
    executeFetch(
      `${BASE_URL}/api/ai/research?topic=${encodeURIComponent(params.topic)}`
    ),
}

/**
 * @function getNews
 * @description Fetches cryptocurrency news articles.
 * @param {Object} params
 * @param {number} [params.limit] - Optional limit on number of articles.
 * @returns {ToolResult} News data.
 */
export const getNews: ToolDefinition<
  z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>
> = {
  name: "get_news",
  description: "Fetches cryptocurrency news articles.",
  parameters: z.object({ limit: z.number().optional() }),
  execute: async (params) => {
    const url = params.limit
      ? `${BASE_URL}/api/news?limit=${params.limit}`
      : `${BASE_URL}/api/news`
    return executeFetch(url)
  },
}
