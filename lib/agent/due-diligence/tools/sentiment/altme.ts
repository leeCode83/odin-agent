/**
 * @file sentiment/altme.ts
 * @description Tool wrapper around the Alternative.me Fear & Greed Index client.
 * @module tools/sentiment
 * @layer util
 */

import { z } from "zod"
import { fetchFearGreedIndex } from "@/lib/data/sentiment/altme"
import type { ToolDefinition } from "../types"

/**
 * @constant FearGreedDataSchema
 * @description Structured get_fear_greed output consumed by deterministic scoring:
 *   index value < 30 = fear (contrarian buy), > 70 = greed (froth).
 */
export const FearGreedDataSchema = z.object({
  value: z.number().nullable(),
  classification: z.string().nullable(),
})

/** @typedef {z.infer<typeof FearGreedDataSchema>} FearGreedData */
export type FearGreedData = z.infer<typeof FearGreedDataSchema>

/**
 * @function getFearGreed
 * @description Fetches the current Fear & Greed index from Alternative.me.
 * @returns {ToolResult} The numerical value and classification of the index.
 */
export const getFearGreed: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "get_fear_greed",
  description: "Fetches the current Fear & Greed index from Alternative.me.",
  parameters: z.object({}),
  execute: async () => {
    const start = Date.now()
    try {
      const data = await fetchFearGreedIndex()
      return {
        success: true,
        data: { value: data.value, classification: data.classification },
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
