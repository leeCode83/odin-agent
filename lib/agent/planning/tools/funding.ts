/**
 * @file planning/tools/funding.ts
 * @description Funding-regime and OI/funding divergence tools for the planning
 * swarm. Uses only Hyperliquid public data: current funding/OI/mark from
 * fetchOnchainData/fetchMarkPrice, predicted funding (HlPerp venue) from the
 * predictedFundings info endpoint when available. Honest approximation label —
 * a snapshot, not history.
 * @module planning/tools/funding
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/due-diligence/tools/types"
import { createHLClient, fetchOnchainData, fetchMarkPrice, fetchCandles } from "@/lib/data/hyperliquid"
import { RiskFlag } from "@/lib/agent/shared/risk-flags"
import { withTimeout } from "@/lib/utils"

/**
 * @interface FundingToolContext
 * @description Context passed to the funding tool builders. Reserved for
 * orchestrator pattern parity with the other planning tool modules; the
 * funding tools take asset per call and do not use ctx.
 * @property {string} walletAddress - User wallet address.
 * @property {string} userId - User identifier.
 * @property {string} asset - Default asset ticker (unused; tools take asset per call).
 * @property {number} equity - Account equity in USDC (unused).
 */
export interface FundingToolContext {
  walletAddress: string
  userId: string
  asset: string
  equity: number
}

/**
 * @constant FUNDING_OVERHEAT
 * @description Per-8h funding rate threshold (decimal) above which the regime
 * is considered overheated. Matches the perp-funding-basis skill table:
 * > +0.05% per 8h = extreme long crowding (contrarian signal).
 */
const FUNDING_OVERHEAT = 0.0005

/**
 * @constant PRICE_MOVE_PCT
 * @description Minimum 24h price move (%) treated as directional for the
 * divergence check.
 */
const PRICE_MOVE_PCT = 0.5

/**
 * @constant OI_TURNOVER_UP_PCT
 * @description 24h-volume-to-OI turnover (%) above which leverage churn counts
 * as "OI up". Mirrors the skill's +/-5% 24h OI-change threshold.
 */
const OI_TURNOVER_UP_PCT = 5

/**
 * @constant FUNDING_STRONG
 * @description Funding magnitude (decimal) considered "strongly positive/negative"
 * for divergence logic. Same 0.05% threshold as the regime check.
 */
const FUNDING_STRONG = 0.0005

/**
 * @constant HL_PERP_VENUE
 * @description Exchange symbol for Hyperliquid's own venue in the
 * predictedFundings response.
 */
const HL_PERP_VENUE = "HlPerp"

/**
 * @function fetchPredictedFunding
 * @description Best-effort fetch of Hyperliquid's predicted funding for an
 * asset from the HlPerp venue only (resolved spec 16.3). Never throws — returns
 * null when unavailable, keeping the tool functional.
 * @param {ReturnType<typeof createHLClient>} client - Hyperliquid InfoClient.
 * @param {string} asset - Asset ticker (e.g. "ETH").
 * @returns {Promise<number | null>} Predicted funding rate as a decimal, or null.
 */
async function fetchPredictedFunding(client: ReturnType<typeof createHLClient>, asset: string): Promise<number | null> {
  const rows = await withTimeout(client.predictedFundings(), 15_000)
  const row = rows.find((r) => r[0] === asset)
  const hl = row?.[1].find((e) => e[0] === HL_PERP_VENUE)
  // reason: hl[1] is null when the venue has no prediction for the asset
  return hl && hl[1] !== null ? parseFloat(hl[1].fundingRate) : null
}

/**
 * @function buildFundingTools
 * @description Builds the funding-regime and OI/funding divergence tools.
 * @param {FundingToolContext} _ctx - Context (unused; tools take asset per call).
 * @returns {ToolDefinition[]} analyze_funding_regime, detect_oi_funding_divergence.
 */
export function buildFundingTools(_ctx: FundingToolContext): ToolDefinition[] {
  // reason: ctx reserved for orchestrator pattern parity; funding tools take asset per call
  void _ctx
  return [
    {
      name: "analyze_funding_regime",
      description:
        "Check whether perpetual funding is overheating for an asset (approx — HL funding snapshot, not history). " +
        "|fundingRate| above 0.05% per 8h is overheated (long if positive, short if negative) — a NO_TRADE contrarian signal. " +
        "Includes current funding, open interest, mark price, and predicted funding (Hyperliquid HlPerp venue) when available.",
      parameters: z.object({
        asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const client = createHLClient()
          const onchain = await fetchOnchainData(client, params.asset)
          // reason: ctx markPx is the primary source; fetchMarkPrice is a retried fallback
          const markPrice = onchain.markPrice > 0 ? onchain.markPrice : await fetchMarkPrice(params.asset)
          let predictedFunding: number | null = null
          try {
            predictedFunding = await fetchPredictedFunding(client, params.asset)
          } catch {
            // reason: predicted funding is best-effort; the tool must not fail without it
          }
          const absFunding = Math.abs(onchain.fundingRate)
          const regime =
            absFunding > FUNDING_OVERHEAT
              ? onchain.fundingRate > 0
                ? "overheated_long"
                : "overheated_short"
              : "normal"
          // reason: structured enum flag for the overheated rule (P4 SA2) —
          // one flag, either direction; free-text narrative stays in notes.
          const risk_flags: RiskFlag[] =
            regime === "normal" ? [] : [RiskFlag.funding_overheated]
          return {
            success: true,
            data: {
              regime,
              fundingRate: onchain.fundingRate,
              openInterest: onchain.openInterest,
              markPrice,
              predictedFunding,
              risk_flags,
              notes: "approx — HL funding snapshot; predicted funding from HL HlPerp venue when available",
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
      name: "detect_oi_funding_divergence",
      description:
        "Compare 24h price action vs open interest turnover and funding rate for an asset (approx — HL exposes no OI history; " +
        "oiChangePct is a 24h-volume/OI turnover proxy). Price up + funding strongly negative, or price down + funding strongly " +
        "positive, flags divergence: the trend may reverse.",
      parameters: z.object({
        asset: z.string().describe("Asset ticker (e.g. BTC, ETH)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const client = createHLClient()
          const onchain = await fetchOnchainData(client, params.asset)
          const candles = await fetchCandles(client, params.asset)
          // reason: hourly candles; 24h change = last close vs close 24 candles earlier
          const last = candles[candles.length - 1]?.close
          const prev = candles[candles.length - 25]?.close
          const priceChangePct = last !== undefined && prev !== undefined && prev > 0 ? ((last - prev) / prev) * 100 : 0
          // reason: HL public API exposes no OI history (verified); dayVolume/OI is the turnover proxy
          const oiChangePct = onchain.openInterest > 0 ? (onchain.dayVolume / onchain.openInterest) * 100 : 0

          const priceUp = priceChangePct >= PRICE_MOVE_PCT
          const priceDown = priceChangePct <= -PRICE_MOVE_PCT
          const fundingStrongPositive = onchain.fundingRate > FUNDING_STRONG
          const fundingStrongNegative = onchain.fundingRate < -FUNDING_STRONG
          const oiUp = oiChangePct > OI_TURNOVER_UP_PCT

          let divergence = false
          let signal: "bullish" | "bearish" | "neutral" = "neutral"
          if (priceUp && fundingStrongNegative) {
            // price rising while shorts pay heavily: long positioning not behind the move
            divergence = true
            signal = "bearish"
          } else if (priceDown && fundingStrongPositive) {
            // price falling while longs pay heavily: contrarian long setup
            divergence = true
            signal = "bullish"
          } else if (priceUp && oiUp && fundingStrongPositive) {
            // leveraged long buildup with churn: overextended, no directional edge
            divergence = false
            signal = "neutral"
          } else if (priceUp && onchain.fundingRate > 0) {
            divergence = false
            signal = "bullish"
          } else if (priceDown && onchain.fundingRate < 0) {
            divergence = false
            signal = "bearish"
          }

          // reason: structured enum flag when divergence is real (P4 SA2) —
          // the overextended-neutral branch (oiUp) deliberately emits none.
          const risk_flags: RiskFlag[] = divergence ? [RiskFlag.oi_divergence] : []
          return {
            success: true,
            data: {
              divergence,
              priceChangePct: Math.round(priceChangePct * 100) / 100,
              oiChangePct: Math.round(oiChangePct * 100) / 100,
              fundingRate: onchain.fundingRate,
              signal,
              risk_flags,
              notes:
                "approximation — HL exposes no OI history; oiChangePct is a 24h-volume/OI turnover proxy, not a real OI change",
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
