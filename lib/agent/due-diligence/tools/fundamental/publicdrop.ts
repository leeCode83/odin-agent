/**
 * @file tools/fundamental/publicdrop.ts
 * @description Tool definitions wrapping PublicDrop API calls — unlock events and inflation data.
 * @module tools/fundamental
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/due-diligence/tools/types"

const PD_BASE = process.env.PUBLICDROP_BASE_URL || "https://api.publicdrop.org/v1"

/**
 * @constant InflationDataSchema
 * @description Structured get_inflation_data output consumed by deterministic scoring:
 *   currentRatePercent (annual inflation %) drives the inflation signal.
 */
export const InflationDataSchema = z.object({
  currentRatePercent: z.number().nullable(),
  nextRateChangeDate: z.string().nullable(),
  nextRatePercent: z.number().nullable(),
  historical: z.array(z.object({ date: z.string(), rate_percent: z.number() })),
})

/** @typedef {z.infer<typeof InflationDataSchema>} InflationData */
export type InflationData = z.infer<typeof InflationDataSchema>

async function pdFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${PD_BASE}${path}`)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const publicDropTools: ToolDefinition[] = [
  {
    name: "get_unlock_events",
    description: "Fetch token unlock schedule from PublicDrop for a given asset",
    parameters: z.object({
      asset: z.string().describe("Asset ticker or identifier (e.g. 'BTC', 'ETH')"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const data = await pdFetch<
          Array<{ date: string; amount: number; value_usd?: number; source?: string; notes?: string }>
        >(`/assets/${params.asset.toLowerCase()}/unlocks`)

        return {
          success: true,
          data: data ?? [],
          metadata: { source: "publicdrop", latencyMs: Date.now() - start },
        }
      } catch {
        return {
          success: false,
          error: `Failed to fetch unlock events for ${params.asset}`,
          metadata: { source: "publicdrop", latencyMs: Date.now() - start },
        }
      }
    },
  },

  {
    name: "get_inflation_data",
    description: "Fetch inflation rate data from PublicDrop for a given asset",
    parameters: z.object({
      asset: z.string().describe("Asset ticker or identifier (e.g. 'BTC', 'ETH')"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const data = await pdFetch<{
        current_rate_percent?: number | null
        next_rate_change_date?: string | null
        next_rate_percent?: number | null
        historical?: Array<{ date: string; rate_percent: number }>
      }>(`/assets/${params.asset.toLowerCase()}/inflation`)

      if (!data) {
        return {
          success: false,
          error: `No inflation data from PublicDrop for ${params.asset}`,
          metadata: { source: "publicdrop", latencyMs: Date.now() - start },
        }
      }

      return {
        success: true,
        data: {
          currentRatePercent: data.current_rate_percent ?? null,
          nextRateChangeDate: data.next_rate_change_date ?? null,
          nextRatePercent: data.next_rate_percent ?? null,
          historical: data.historical ?? [],
        },
        metadata: { source: "publicdrop", latencyMs: Date.now() - start },
      }
    },
  },
]
