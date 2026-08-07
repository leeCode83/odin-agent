import { z } from "zod"
import type { ToolDefinition } from "../types"

const BASE_URL = process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3"

async function fetchWithTimeout(url: string, ms = 10_000): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res
  } finally {
    clearTimeout(id)
  }
}

async function fetchCoinData(coingeckoId: string): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${BASE_URL}/coins/${coingeckoId}`)
  if (!res.ok) {
    throw new Error(`CoinGecko API error ${res.status} for ${coingeckoId}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

export function getTokenSupplyTool(): ToolDefinition {
  return {
    name: "get_token_supply",
    description: "Get circulating, max, and total supply for a token from CoinGecko",
    parameters: z.object({
      coingeckoId: z.string().describe("CoinGecko coin ID (e.g. bitcoin, ethereum)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const data = await fetchCoinData(params.coingeckoId)
        return {
          success: true,
          data: {
            circulatingSupply: data.circulating_supply ?? null,
            maxSupply: data.max_supply ?? null,
            totalSupply: data.total_supply ?? null,
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
}

export function getMarketCapTool(): ToolDefinition {
  return {
    name: "get_market_cap",
    description: "Get market cap and rank for a token from CoinGecko",
    parameters: z.object({
      coingeckoId: z.string().describe("CoinGecko coin ID (e.g. bitcoin, ethereum)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const data = await fetchCoinData(params.coingeckoId)
        const marketData = data.market_data as Record<string, unknown> | undefined
        const marketCap = (marketData?.market_cap as Record<string, number> | undefined)?.usd ?? null
        const marketCapRank = (data.market_cap_rank as number) ?? null
        return {
          success: true,
          data: { marketCapUsd: marketCap, marketCapRank },
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
}

export function get24hVolumeTool(): ToolDefinition {
  return {
    name: "get_24h_volume",
    description: "Get 24h trading volume for a token from CoinGecko",
    parameters: z.object({
      coingeckoId: z.string().describe("CoinGecko coin ID (e.g. bitcoin, ethereum)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const data = await fetchCoinData(params.coingeckoId)
        const marketData = data.market_data as Record<string, unknown> | undefined
        const totalVolume = (marketData?.total_volume as Record<string, number> | undefined)?.usd ?? null
        return {
          success: true,
          data: { totalVolumeUsd: totalVolume },
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
}
