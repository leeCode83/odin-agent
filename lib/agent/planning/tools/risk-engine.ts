/**
 * @file planning/tools/risk-engine.ts
 * @description Deterministic risk-engine tools (no LLM): ATR, SL/TP, position
 * sizing, and leverage capping, wrapping the pure functions in
 * lib/agent/planning/risk-engine.ts behind ToolDefinitions.
 * @module planning/tools/risk-engine
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/tools/types"
import type { Side } from "@/lib/agent/types"
import { fetchCandlesForATR, fetchMarkPrice } from "@/lib/data/hyperliquid"
import { computeATR, computeSLTP, computePositionSize, capLeverage } from "@/lib/agent/planning/risk-engine"

/**
 * @interface RiskEngineToolContext
 * @description Context passed to risk-engine tool builders.
 * @property {string} asset - Default asset ticker used when a tool's params omit asset.
 * @property {number} [equity] - Account equity in USDC, pre-fetched by the orchestrator;
 *   used by compute_position_size when params omit equity.
 */
export interface RiskEngineToolContext {
  asset: string
  equity?: number
}

/**
 * @function round2
 * @description Rounds a number to 2 decimal places for deterministic tool output.
 * @param {number} n - Value to round.
 * @returns {number} Rounded value.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * @function buildRiskEngineTools
 * @description Builds the 4 deterministic risk-engine tools bound to a context.
 * @param {RiskEngineToolContext} ctx - Context providing asset and equity fallbacks.
 * @returns {ToolDefinition[]} compute_atr, compute_sltp, compute_position_size, cap_leverage.
 */
export function buildRiskEngineTools(ctx: RiskEngineToolContext): ToolDefinition[] {
  return [
    {
      name: "compute_atr",
      description: "Compute Average True Range (ATR) and ATR as a percentage of current mark price for an asset. Fetches 20 one-hour candles from Hyperliquid and uses them to derive volatility for stop-loss and take-profit placement.",
      parameters: z.object({
        asset: z.string().optional().describe("Asset ticker (e.g. BTC, ETH). Defaults to the planning context asset."),
        period: z.number().int().min(2).optional().default(14).describe("ATR smoothing period in candles (default 14)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const asset = params.asset ?? ctx.asset
          const candles = await fetchCandlesForATR(asset, "1h", 20)
          const atr = computeATR(candles, params.period)
          const markPrice = await fetchMarkPrice(asset)
          return {
            success: true,
            data: {
              atr: round2(atr),
              atrPercentOfEntry: round2((atr / markPrice) * 100),
              source: "hyperliquid",
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
      name: "compute_sltp",
      description: "Compute stop-loss and take-profit levels from entry price, ATR, and position side, using ATR multipliers for risk/reward (default 1.5x SL, 3.0x TP).",
      parameters: z.object({
        entry: z.number().positive().describe("Entry price in USDC"),
        atr: z.number().positive().describe("Current ATR value for the asset"),
        side: z.enum(["long", "short"]).describe("Position side"),
        slMultiplier: z.number().positive().optional().default(1.5).describe("ATR multiplier for stop-loss distance (default 1.5)"),
        tpMultiplier: z.number().positive().optional().default(3.0).describe("ATR multiplier for take-profit distance (default 3.0)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const { stopLoss, takeProfit } = computeSLTP(
            params.entry,
            params.atr,
            params.side as Side,
            { slMultiplier: params.slMultiplier, tpMultiplier: params.tpMultiplier }
          )
          return {
            success: true,
            data: { stopLoss, takeProfit },
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        }
      },
    },
    {
      name: "compute_position_size",
      description: "Compute position size in USDC and contracts from equity, entry, stop-loss, and risk percentage. Equity is pre-fetched by the orchestrator and passed via context when the param is omitted.",
      parameters: z.object({
        equity: z.number().positive().optional().describe("Account equity in USDC. Defaults to the planning context equity (pre-fetched by the orchestrator)."),
        entry: z.number().positive().describe("Entry price in USDC"),
        stopLoss: z.number().positive().describe("Stop-loss price in USDC"),
        riskPercent: z.number().positive().describe("Percentage of equity to risk per trade (0-100)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const equity = params.equity ?? ctx.equity
          // reason: get_equity tool removed (spec 16.4) — orchestrator pre-fetches equity once via fetchUserEquity
          if (equity == null || equity <= 0) {
            return {
              success: false,
              error: "equity not available — pass equity param or provide context equity",
              metadata: { source: "risk-engine", latencyMs: Date.now() - start },
            }
          }
          const { positionSizeUsdc, positionSizeContracts } = computePositionSize(
            equity,
            params.entry,
            params.stopLoss,
            params.riskPercent
          )
          return {
            success: true,
            data: { positionSizeUsdc, positionSizeContracts },
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        }
      },
    },
    {
      name: "cap_leverage",
      description: "Cap an LLM-suggested leverage value to the user's maximum allowed leverage from risk thresholds, rounded to 1 decimal place.",
      parameters: z.object({
        llmSuggested: z.number().positive().describe("Leverage suggested by the LLM"),
        maxAllowed: z.number().positive().describe("Maximum leverage allowed by the user's risk thresholds"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          return {
            success: true,
            data: { leverage: capLeverage(params.llmSuggested, params.maxAllowed) },
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "risk-engine", latencyMs: Date.now() - start },
          }
        }
      },
    },
  ]
}
