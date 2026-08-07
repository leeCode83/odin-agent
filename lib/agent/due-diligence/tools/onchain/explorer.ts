import { z } from "zod"
import type { ToolDefinition } from "../types"

export function getWhaleTxnsTool(): ToolDefinition {
  return {
    name: "get_whale_txns",
    description: "Get recent large/whale transactions for an asset. For MVP, returns simulated data — real block explorer API integration pending.",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
      minValue: z.number().optional().describe("Minimum transaction value in USD"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const txns = [
        { hash: "0xabc...def", value: 5000000, from: "0x1111...aaaa", to: "0x2222...bbbb", timestamp: Date.now() - 60000 },
        { hash: "0xdef...789", value: 3000000, from: "0x3333...cccc", to: "0x4444...dddd", timestamp: Date.now() - 120000 },
        { hash: "0x789...012", value: 10000000, from: "0x5555...eeee", to: "0x6666...ffff", timestamp: Date.now() - 300000 },
      ]
      const filtered = params.minValue ? txns.filter((t) => t.value >= params.minValue!) : txns
      return {
        success: true,
        data: { asset: params.asset, transactions: filtered },
        metadata: { source: "explorer", latencyMs: Date.now() - start },
      }
    },
  }
}

export function getExchangeFlowTool(): ToolDefinition {
  return {
    name: "get_exchange_flow",
    description: "Track large transfers to/from known exchange addresses for an asset. For MVP, returns simulated data — real exchange flow API pending.",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      return {
        success: true,
        data: {
          asset: params.asset,
          inflow: 15000000,
          outflow: 12000000,
          netflow: 3000000,
        },
        metadata: { source: "explorer", latencyMs: Date.now() - start },
      }
    },
  }
}
