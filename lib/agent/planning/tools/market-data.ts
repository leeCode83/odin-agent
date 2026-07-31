/**
 * @file planning/tools/market-data.ts
 * @description Market-data tools for the planning swarm: mark price, candles,
 * risk thresholds, graph patterns, and order book depth, wrapping existing
 * fetchers in lib/data/hyperliquid.ts and lib/db/risk-thresholds.ts.
 * @module planning/tools/market-data
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/tools/types"
import { fetchCandlesForATR, fetchMarkPrice } from "@/lib/data/hyperliquid"
import { getOrderbookDepthTool } from "@/lib/agent/tools/onchain/hyperliquid"
import { getRiskThresholds, envDefaults } from "@/lib/db/risk-thresholds"
import { queryGraphPatterns } from "@/lib/db/graph-memory"
import type { RiskThresholds } from "@/lib/agent/types"

/**
 * @interface MarketDataToolContext
 * @description Context passed to market-data tool builders.
 * @property {string} asset - Default asset ticker used when a tool's params omit asset.
 * @property {string} userId - Default user ID used when get_risk_thresholds params omit userId.
 */
export interface MarketDataToolContext {
  asset: string
  userId: string
}

/**
 * @function buildMarketDataTools
 * @description Builds the 5 market-data tools bound to a context. No get_equity
 * tool (spec 16.4) — the orchestrator pre-fetches equity once and passes it via ctx.
 * @param {MarketDataToolContext} ctx - Context providing asset and userId fallbacks.
 * @returns {ToolDefinition[]} get_mark_price, get_candles, get_risk_thresholds,
 *   get_graph_patterns, get_orderbook_depth.
 */
export function buildMarketDataTools(ctx: MarketDataToolContext): ToolDefinition[] {
  return [
    {
      name: "get_mark_price",
      description: "Get the current mark price for a perpetual asset from Hyperliquid.",
      parameters: z.object({
        asset: z.string().optional().describe("Asset ticker (e.g. BTC, ETH). Defaults to the planning context asset."),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const asset = params.asset ?? ctx.asset
          const markPrice = await fetchMarkPrice(asset)
          return {
            success: true,
            data: { markPrice },
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
    },
    {
      name: "get_candles",
      description: "Get OHLCV candles for an asset from Hyperliquid (defaults to 20 one-hour candles) for volatility and indicator analysis.",
      parameters: z.object({
        asset: z.string().optional().describe("Asset ticker (e.g. BTC, ETH). Defaults to the planning context asset."),
        interval: z.string().optional().default("1h").describe("Candle interval (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M). Default 1h"),
        count: z.number().int().min(1).optional().default(20).describe("Number of candles to fetch (default 20)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const asset = params.asset ?? ctx.asset
          const candles = await fetchCandlesForATR(
            asset,
            // reason: fetchCandlesForATR's interval param is a closed union; validated upstream by Zod
            params.interval as Parameters<typeof fetchCandlesForATR>[1],
            params.count
          )
          return {
            success: true,
            data: { candles },
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
    },
    {
      name: "get_risk_thresholds",
      description: "Get the user's risk thresholds (confidence threshold, max position, max leverage, risk per trade) from the database, falling back to environment defaults.",
      parameters: z.object({
        userId: z.string().optional().describe("User ID. Defaults to the planning context userId."),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const userId = params.userId ?? ctx.userId
          const thresholds: RiskThresholds = (await getRiskThresholds(userId)) ?? envDefaults()
          return {
            success: true,
            data: { thresholds },
            metadata: { source: "risk_thresholds", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "risk_thresholds", latencyMs: Date.now() - start },
          }
        }
      },
    },
    {
      name: "get_graph_patterns",
      description: "Query the historical trade graph for patterns matching the asset, category, and signals, with outcome frequencies.",
      parameters: z.object({
        asset: z.string().optional().describe("Asset ticker (e.g. BTC, ETH). Defaults to the planning context asset."),
        category: z.string().optional().default("").describe("Asset category to match against historical decisions (default empty)"),
        signals: z.array(z.string()).optional().default([]).describe("Signal names to match against historical patterns"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const asset = params.asset ?? ctx.asset
          const patterns = await queryGraphPatterns(asset, params.category, params.signals)
          return {
            success: true,
            data: { patterns },
            metadata: { source: "graph-memory", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "graph-memory", latencyMs: Date.now() - start },
          }
        }
      },
    },
    // reason: re-export of existing onchain tool, no rewrite per T2 brief
    getOrderbookDepthTool(),
  ]
}
