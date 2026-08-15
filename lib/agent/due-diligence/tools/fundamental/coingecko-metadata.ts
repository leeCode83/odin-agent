/**
 * @file tools/fundamental/coingecko-metadata.ts
 * @description Tool definitions wrapping CoinGecko API calls for fundamental analysis — metadata, tokenomics, ATH, dev activity.
 * @module tools/fundamental
 */

import { z } from "zod"
import { withTimeout, withRetry } from "@/lib/utils"
import type { ToolDefinition } from "@/lib/agent/due-diligence/tools/types"

const CG_BASE = process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3"
const PD_BASE = process.env.PUBLICDROP_BASE_URL || "https://api.publicdrop.org/v1"

async function cgFetch<T>(path: string): Promise<T | null> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(`${CG_BASE}${path}`), 15_000)
      if (!res.ok) return null
      return (await res.json()) as T
    },
    { retries: 2 },
  ).catch(() => null)
}

async function pdFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${PD_BASE}${path}`)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

const coingeckoIdParam = z.object({
  coingeckoId: z.string().describe("CoinGecko asset ID (e.g. 'bitcoin', 'ethereum')"),
})

/**
 * @constant TokenomicsDataSchema
 * @description Structured get_tokenomics output consumed by deterministic scoring:
 *   total/max supply ratio drives the unlock-risk signal.
 */
export const TokenomicsDataSchema = z.object({
  circulatingSupply: z.number().nullable(),
  totalSupply: z.number().nullable(),
  maxSupply: z.number().nullable(),
  unlockEvents: z.array(z.object({ date: z.string(), amount: z.number(), source: z.string().optional() })),
})

/** @typedef {z.infer<typeof TokenomicsDataSchema>} TokenomicsData */
export type TokenomicsData = z.infer<typeof TokenomicsDataSchema>

/**
 * @constant AthDataSchema
 * @description Structured get_ath output consumed by deterministic scoring:
 *   athChangePercent (drawdown from ATH) drives the discount/froth signal.
 */
export const AthDataSchema = z.object({
  athUsd: z.number().nullable(),
  athChangePercent: z.number().nullable(),
  athDate: z.string().nullable(),
})

/** @typedef {z.infer<typeof AthDataSchema>} AthData */
export type AthData = z.infer<typeof AthDataSchema>

/**
 * @constant DevActivityDataSchema
 * @description Structured get_developer_activity output consumed by deterministic
 *   scoring: commitCount4Weeks drives the development-activity signal.
 */
export const DevActivityDataSchema = z.object({
  forks: z.number().nullable(),
  stars: z.number().nullable(),
  subscribers: z.number().nullable(),
  totalIssues: z.number().nullable(),
  closedIssues: z.number().nullable(),
  pullRequestsMerged: z.number().nullable(),
  commitCount4Weeks: z.number().nullable(),
})

/** @typedef {z.infer<typeof DevActivityDataSchema>} DevActivityData */
export type DevActivityData = z.infer<typeof DevActivityDataSchema>

export const coingeckoMetadataTools: ToolDefinition[] = [
  {
    name: "get_coin_metadata",
    description: "Fetch coin metadata from CoinGecko: name, description, links, categories",
    parameters: coingeckoIdParam,
    execute: async (params) => {
      const start = Date.now()
      const data = await cgFetch<{
        name?: string
        description?: { en?: string | null }
        links?: Record<string, unknown>
        categories?: string[]
      }>(`/coins/${params.coingeckoId}?localization=false&tickers=false&community_data=false&developer_data=false`)

      if (!data) {
        return {
          success: false,
          error: `No data from CoinGecko for ${params.coingeckoId}`,
          metadata: { source: "coingecko", latencyMs: Date.now() - start },
        }
      }

      return {
        success: true,
        data: {
          name: data.name ?? null,
          description: data.description?.en ?? null,
          links: data.links ?? null,
          categories: data.categories ?? [],
        },
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    },
  },

  {
    name: "get_tokenomics",
    description: "Fetch token supply data from CoinGecko and unlock events from PublicDrop",
    parameters: coingeckoIdParam,
    execute: async (params) => {
      const start = Date.now()
      const [cgData, unlockData] = await Promise.all([
        cgFetch<{
          market_data?: {
            circulating_supply?: number | null
            total_supply?: number | null
            max_supply?: number | null
          }
        }>(`/coins/${params.coingeckoId}?localization=false&tickers=false&community_data=false&developer_data=false`),
        pdFetch<Array<{ date: string; amount: number; source?: string }>>(
          `/assets/${params.coingeckoId}/unlocks`,
        ),
      ])

      if (!cgData) {
        return {
          success: false,
          error: `No tokenomics data from CoinGecko for ${params.coingeckoId}`,
          metadata: { source: "coingecko+publicdrop", latencyMs: Date.now() - start },
        }
      }

      const md = cgData.market_data ?? {}
      return {
        success: true,
        data: {
          circulatingSupply: md.circulating_supply ?? null,
          totalSupply: md.total_supply ?? null,
          maxSupply: md.max_supply ?? null,
          unlockEvents: unlockData ?? [],
        },
        metadata: { source: "coingecko+publicdrop", latencyMs: Date.now() - start },
      }
    },
  },

  {
    name: "get_ath",
    description: "Fetch all-time-high price data from CoinGecko",
    parameters: coingeckoIdParam,
    execute: async (params) => {
      const start = Date.now()
      const data = await cgFetch<{
        market_data?: {
          ath?: { usd?: number | null }
          ath_change_percentage?: { usd?: number | null }
          ath_date?: { usd?: string | null }
        }
      }>(`/coins/${params.coingeckoId}?localization=false&tickers=false&community_data=false&developer_data=false`)

      if (!data) {
        return {
          success: false,
          error: `No ATH data from CoinGecko for ${params.coingeckoId}`,
          metadata: { source: "coingecko", latencyMs: Date.now() - start },
        }
      }

      const md = data.market_data ?? {}
      return {
        success: true,
        data: {
          athUsd: md.ath?.usd ?? null,
          athChangePercent: md.ath_change_percentage?.usd ?? null,
          athDate: md.ath_date?.usd ?? null,
        },
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    },
  },

  {
    name: "get_developer_activity",
    description: "Fetch GitHub developer activity data from CoinGecko",
    parameters: coingeckoIdParam,
    execute: async (params) => {
      const start = Date.now()
      const data = await cgFetch<{
        developer_data?: {
          forks?: number | null
          stars?: number | null
          subscribers?: number | null
          total_issues?: number | null
          closed_issues?: number | null
          pull_requests_merged?: number | null
          commit_count_4_weeks?: number | null
        }
      }>(`/coins/${params.coingeckoId}?localization=false&tickers=false&community_data=true&developer_data=true`)

      if (!data) {
        return {
          success: false,
          error: `No developer data from CoinGecko for ${params.coingeckoId}`,
          metadata: { source: "coingecko", latencyMs: Date.now() - start },
        }
      }

      const dd = data.developer_data ?? {}
      return {
        success: true,
        data: {
          forks: dd.forks ?? null,
          stars: dd.stars ?? null,
          subscribers: dd.subscribers ?? null,
          totalIssues: dd.total_issues ?? null,
          closedIssues: dd.closed_issues ?? null,
          pullRequestsMerged: dd.pull_requests_merged ?? null,
          commitCount4Weeks: dd.commit_count_4_weeks ?? null,
        },
        metadata: { source: "coingecko", latencyMs: Date.now() - start },
      }
    },
  },
]
