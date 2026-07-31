/**
 * @file planning/tools/liquidation.ts
 * @description Liquidation-zone and cascade-risk tools for the planning swarm.
 * APPROXIMATION: Hyperliquid's public API exposes no liquidation data (verified
 * against HL docs), so orderbook liquidity clusters, funding magnitude, OI, and
 * orderbook thinness are used as proxies. Every tool carries the
 * "approximation" label in its description AND result notes.
 * @module planning/tools/liquidation
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/tools/types"
import { createHLClient, fetchOnchainData } from "@/lib/data/hyperliquid"
import { getOrderbookDepthTool } from "@/lib/agent/tools/onchain/hyperliquid"

/**
 * @interface LiquidationToolContext
 * @description Context passed to the liquidation tool builders. Reserved for
 * orchestrator pattern parity; the liquidation tools take asset per call and
 * do not use ctx.
 * @property {string} walletAddress - User wallet address.
 * @property {string} userId - User identifier.
 * @property {string} asset - Default asset ticker (unused; tools take asset per call).
 * @property {number} equity - Account equity in USDC (unused).
 */
export interface LiquidationToolContext {
  walletAddress: string
  userId: string
  asset: string
  equity: number
}

/**
 * @constant CLUSTER_GAP_PCT
 * @description Price gap (fraction of price) under which adjacent orderbook
 * levels are merged into one liquidity cluster.
 */
const CLUSTER_GAP_PCT = 0.005

/**
 * @constant STOP_PROXIMITY_PCT
 * @description Distance (fraction of cluster price) within which a stop-loss is
 * considered to sit in a magnet zone.
 */
const STOP_PROXIMITY_PCT = 0.005

/**
 * @constant FUNDING_ELEVATED
 * @description Funding magnitude (decimal) that contributes 1 cascade-risk point.
 */
const FUNDING_ELEVATED = 0.0005

/**
 * @constant FUNDING_EXTREME
 * @description Funding magnitude (decimal) that contributes 2 cascade-risk points.
 */
const FUNDING_EXTREME = 0.001

/**
 * @constant OI_LARGE
 * @description Open interest (USDC) above which the position base is large
 * enough to contribute a cascade-risk point.
 */
const OI_LARGE = 250_000_000

/**
 * @constant BOOK_THIN_FRACTION
 * @description Top-of-book value below this fraction of open interest counts as
 * a thin orderbook (cascade-risk point).
 */
const BOOK_THIN_FRACTION = 0.002

/**
 * @interface BookLevel
 * @description A single orderbook price level returned by get_orderbook_depth.
 * @property {number} price - Level price.
 * @property {number} size - Level size (contracts or base units).
 */
interface BookLevel {
  price: number
  size: number
}

/**
 * @interface LiquidityCluster
 * @description A merged group of nearby orderbook levels acting as a proxy for
 * a liquidation magnet zone.
 * @property {number} price - Size-weighted cluster price.
 * @property {number} size - Aggregate level size in the cluster.
 */
interface LiquidityCluster {
  price: number
  size: number
}

/**
 * @function buildClusters
 * @description Greedily merges orderbook levels whose price gap is within
 * CLUSTER_GAP_PCT of each other into size-weighted clusters.
 * @param {BookLevel[]} levels - Price levels (bids or asks).
 * @param {"desc" | "asc"} direction - Sort direction: bids descend, asks ascend.
 * @returns {LiquidityCluster[]} Merged clusters in price order.
 */
function buildClusters(levels: BookLevel[], direction: "desc" | "asc"): LiquidityCluster[] {
  const sorted = [...levels].sort((a, b) => (direction === "desc" ? b.price - a.price : a.price - b.price))
  const clusters: LiquidityCluster[] = []
  for (const level of sorted) {
    const last = clusters[clusters.length - 1]
    // reason: merge levels within 0.5% of each other into one magnet zone; price stays size-weighted
    if (last && Math.abs(level.price - last.price) / last.price <= CLUSTER_GAP_PCT) {
      last.size += level.size
      last.price = (last.price * (last.size - level.size) + level.price * level.size) / last.size
    } else {
      clusters.push({ price: level.price, size: level.size })
    }
  }
  return clusters
}

/**
 * @function nearestCluster
 * @description Returns the cluster nearest to a reference price, or null.
 * @param {LiquidityCluster[]} clusters - Candidate clusters.
 * @param {number} midPrice - Reference price (market mid).
 * @returns {LiquidityCluster | null} Nearest cluster, or null when empty.
 */
function nearestCluster(clusters: LiquidityCluster[], midPrice: number): LiquidityCluster | null {
  if (clusters.length === 0) return null
  return clusters.reduce((best, c) => (Math.abs(c.price - midPrice) < Math.abs(best.price - midPrice) ? c : best))
}

/**
 * @function buildLiquidationTools
 * @description Builds the liquidation-zone and cascade-risk approximation tools.
 * @param {LiquidationToolContext} _ctx - Context (unused; tools take asset per call).
 * @returns {ToolDefinition[]} check_liquidation_zones, assess_cascade_risk.
 */
export function buildLiquidationTools(_ctx: LiquidationToolContext): ToolDefinition[] {
  // reason: ctx reserved for orchestrator pattern parity; liquidation tools take asset per call
  void _ctx
  return [
    {
      name: "check_liquidation_zones",
      description:
        "Check whether a stop-loss sits near a liquidation magnet zone (approximation — Hyperliquid exposes no public " +
        "liquidation data; nearest bid/ask liquidity clusters from the orderbook are used as a proxy). Warns when the " +
        "stop-loss is within 0.5% of a cluster.",
      parameters: z.object({
        asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
        entryPrice: z.number().positive().describe("Planned entry price in USD"),
        stopLoss: z.number().positive().describe("Planned stop-loss price in USD"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const book = await getOrderbookDepthTool().execute({ asset: params.asset, depth: 20 })
          if (!book.success) {
            return {
              success: false,
              error: book.error ?? "Orderbook unavailable",
              metadata: { source: "hyperliquid", latencyMs: Date.now() - start },
            }
          }
          const bids: BookLevel[] = book.data?.bids ?? []
          const asks: BookLevel[] = book.data?.asks ?? []
          const midPrice: number = book.data?.midPrice ?? 0

          const zones: Array<{ price: number; label: string }> = []
          if (bids.length > 0) {
            const bidCluster = nearestCluster(buildClusters(bids, "desc"), midPrice)
            if (bidCluster) {
              zones.push({ price: Math.round(bidCluster.price * 100) / 100, label: "bid liquidity cluster — liquidation magnet below (approx)" })
            }
          }
          if (asks.length > 0) {
            const askCluster = nearestCluster(buildClusters(asks, "asc"), midPrice)
            if (askCluster) {
              zones.push({ price: Math.round(askCluster.price * 100) / 100, label: "ask liquidity cluster — liquidation magnet above (approx)" })
            }
          }

          // reason: stop-loss inside a magnet zone is a stop-hunt risk; 0.5% matches the cluster gap
          const warning = zones.some((z) => z.price > 0 && Math.abs(params.stopLoss - z.price) / z.price <= STOP_PROXIMITY_PCT)

          return {
            success: true,
            data: {
              warning,
              zones,
              notes:
                "approximation — HL exposes no public liquidation data; nearest orderbook liquidity clusters used as proxy for magnet zones",
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
    },
    {
      name: "assess_cascade_risk",
      description:
        "Assess liquidation-cascade risk for an asset (approximation — Hyperliquid exposes no public liquidation data; " +
        "risk is proxied by funding magnitude + open interest size + orderbook thinness). Returns low | medium | high.",
      parameters: z.object({
        asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const client = createHLClient()
          const onchain = await fetchOnchainData(client, params.asset)

          let score = 0
          const fundingAbs = Math.abs(onchain.fundingRate)
          // reason: extreme funding = crowded positioning = cascade fuel; elevated adds less
          if (fundingAbs > FUNDING_EXTREME) score += 2
          else if (fundingAbs > FUNDING_ELEVATED) score += 1
          // reason: large OI means more positions to liquidate when price breaks
          if (onchain.openInterest > OI_LARGE) score += 1

          const book = await getOrderbookDepthTool().execute({ asset: params.asset, depth: 10 })
          if (book.success && (book.data?.bids?.length ?? 0) > 0 && (book.data?.asks?.length ?? 0) > 0) {
            const midPrice: number = book.data.midPrice ?? 0
            const topValue = (book.data.bids as BookLevel[]).reduce((s, l) => s + l.size, 0) * midPrice
            const topAskValue = (book.data.asks as BookLevel[]).reduce((s, l) => s + l.size, 0) * midPrice
            // reason: thin book = less absorption when liquidations hit; < 0.2% of OI at top of book
            if (onchain.openInterest > 0 && topValue + topAskValue < BOOK_THIN_FRACTION * onchain.openInterest) score += 1
          }

          const cascadeRisk = score >= 3 ? "high" : score === 2 ? "medium" : "low"

          return {
            success: true,
            data: {
              cascadeRisk,
              notes:
                "approximation — HL exposes no public liquidation data; cascade risk proxied by funding magnitude + OI size + orderbook thinness",
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
    },
  ]
}
