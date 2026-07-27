import { z } from "zod"
import { fetchGlobalMarket, fetchAssetMomentum } from "@/lib/data/sentiment/alternativeme"
import type { ToolDefinition } from "../types"

export const getGlobalMarket: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_global_market",
  description: "Fetches total crypto market cap and 24h volume from Alternative.me for macro sentiment assessment.",
  parameters: z.object({}),
  execute: async () => {
    const start = Date.now()
    try {
      const data = await fetchGlobalMarket()
      return {
        success: true,
        data,
        metadata: { source: "altme", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "altme", latencyMs: Date.now() - start },
      }
    }
  },
}

export const getAssetMomentum: ToolDefinition<
  z.ZodObject<{ coinId: z.ZodNumber }>
> = {
  name: "get_asset_momentum",
  description: "Fetches price change percentages (1h/24h/7d) and volume for a specific asset from Alternative.me. Use this to gauge asset-level sentiment momentum.",
  parameters: z.object({ coinId: z.number().describe("Alternative.me coin ID (see https://api.alternative.me/v2/ticker/)") }),
  execute: async (params) => {
    const start = Date.now()
    try {
      const data = await fetchAssetMomentum(params.coinId)
      return {
        success: true,
        data,
        metadata: { source: "altme", latencyMs: Date.now() - start },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: { source: "altme", latencyMs: Date.now() - start },
      }
    }
  },
}
