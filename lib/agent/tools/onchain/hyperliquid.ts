import { z } from "zod"
import type { ToolDefinition } from "../types"
import { createHLClient } from "@/lib/data/hyperliquid"
import { withTimeout } from "@/lib/utils"

async function getAssetCtx(asset: string) {
  const client = createHLClient()
  const [meta, assetCtxs] = await withTimeout(client.metaAndAssetCtxs(), 15_000)
  const idx = meta.universe.findIndex((u: { name: string }) => u.name === asset)
  if (idx < 0) throw new Error(`Asset ${asset} not found on Hyperliquid`)
  return { client, ctx: assetCtxs[idx], meta }
}

export function getFundingRateTool(): ToolDefinition {
  return {
    name: "get_funding_rate",
    description: "Get current funding rate, mark price, oracle price, and premium for a perpetual asset on Hyperliquid",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const { ctx } = await getAssetCtx(params.asset)
        return {
          success: true,
          data: {
            fundingRate: parseFloat(ctx.funding),
            markPrice: parseFloat(ctx.markPx),
            oraclePrice: parseFloat(ctx.oraclePx),
            premium: ctx.premium !== null ? parseFloat(ctx.premium) : null,
          },
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      }
    },
  }
}

export function getOpenInterestTool(): ToolDefinition {
  return {
    name: "get_open_interest",
    description: "Get open interest for a perpetual asset on Hyperliquid",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const { ctx } = await getAssetCtx(params.asset)
        return {
          success: true,
          data: {
            openInterest: parseFloat(ctx.openInterest),
            oiCapReached: false,
          },
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      }
    },
  }
}

export function getOrderbookDepthTool(): ToolDefinition {
  return {
    name: "get_orderbook_depth",
    description: "Get L2 order book depth for an asset on Hyperliquid",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
      depth: z.number().int().min(1).max(50).optional().default(10).describe("Number of price levels per side"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const client = createHLClient()
        const mids = await withTimeout(client.allMids(), 15_000) as Record<string, string>
        const midPrice = parseFloat(mids[params.asset] ?? "0")
        if (midPrice <= 0) {
          return {
            success: false,
            error: `Mid price not found for ${params.asset}`,
            metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
          }
        }
        try {
          const book = await withTimeout(client.l2Book({ coin: params.asset, nSigFigs: 2 }), 15_000) as { coin: string; levels: Array<Array<{ px: string; sz: string; n: number }>> }
          const asks = book.levels[0]?.slice(0, params.depth).map((l) => ({ price: parseFloat(l.px), size: parseFloat(l.sz) })) ?? []
          const bids = book.levels[1]?.slice(0, params.depth).map((l) => ({ price: parseFloat(l.px), size: parseFloat(l.sz) })) ?? []
          return {
            success: true,
            data: { asset: params.asset, midPrice, bids, asks },
            metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
          }
        } catch {
          return {
            success: true,
            data: { asset: params.asset, midPrice, bids: [], asks: [], note: "L2 book unavailable, mid price only" },
            metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
          }
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      }
    },
  }
}

export function getMarkPriceTool(): ToolDefinition {
  return {
    name: "get_mark_price",
    description: "Get current mid/mark price for an asset on Hyperliquid",
    parameters: z.object({
      asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
    }),
    execute: async (params) => {
      const start = Date.now()
      try {
        const client = createHLClient()
        const mids = await withTimeout(client.allMids(), 15_000) as Record<string, string>
        const markPrice = parseFloat(mids[params.asset])
        if (isNaN(markPrice) || markPrice <= 0) {
          return {
            success: false,
            error: `Mid price not found for ${params.asset}`,
            metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
          }
        }
        return {
          success: true,
          data: { asset: params.asset, markPrice },
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
        }
      }
    },
  }
}
