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

export const getAssetMomentum: ToolDefinition<z.ZodObject<{ coinId: z.ZodCoercedNumber }>> = {
  name: "get_asset_momentum",
  description: "Fetches price change percentages (1h/24h/7d) and volume for a specific asset from Alternative.me. Use this to gauge asset-level sentiment momentum. coinId is the NUMERIC Alternative.me ticker id: bitcoin=1, ethereum=1027, solana=5426, avalanche-2=5805, dogecoin=74, xrp=2.",
  parameters: z.object({ coinId: z.coerce.number().int().positive().describe("Alternative.me numeric coin ID (e.g. 1 for bitcoin, 1027 for ethereum, 5426 for solana)") }),
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
