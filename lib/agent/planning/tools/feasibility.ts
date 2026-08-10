/**
 * @file planning/tools/feasibility.ts
 * @description Deterministic profit-feasibility tool (no LLM): wraps the pure
 * computeProfitFeasibility function in lib/agent/shared/feasibility.ts behind
 * a ToolDefinition, so planning subagents can verify a target profit against
 * trade geometry instead of guessing.
 * @module planning/tools/feasibility
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/due-diligence/tools/types"
import { computeProfitFeasibility } from "@/lib/agent/shared/feasibility"

/**
 * @function buildFeasibilityTools
 * @description Builds the deterministic profit-feasibility tool. Pure — needs
 *   no context, all inputs arrive as tool params.
 * @returns {ToolDefinition[]} Single compute_profit_feasibility tool.
 */
export function buildFeasibilityTools(): ToolDefinition[] {
  return [
    {
      name: "compute_profit_feasibility",
      description: "Deterministically check whether a target profit percent is feasible for a trade defined by entry price, stop-loss, take-profit, and side. Verifies risk/reward ratio (min 1.5), that the target percent fits within the TP distance, and optionally that the target is within 3x ATR of entry. No LLM judgment — pure math.",
      parameters: z.object({
        entryPrice: z.number().positive().describe("Entry price in USDC"),
        stopLoss: z.number().positive().describe("Stop-loss price in USDC"),
        takeProfit: z.number().positive().describe("Take-profit price in USDC"),
        side: z.enum(["long", "short"]).describe("Position side"),
        targetProfitPercent: z.number().positive().describe("Target profit as DECIMAL percent, e.g. 20.5 = 20.5%"),
        atr: z.number().positive().optional().describe("ATR value; adds an expected-move check (target must be within 3x ATR percent of entry)"),
        minRiskRewardRatio: z.number().positive().optional().default(1.5).describe("Minimum acceptable risk/reward ratio (default 1.5)"),
      }),
      execute: async (params) => {
        const start = Date.now()
        try {
          const data = computeProfitFeasibility({
            entryPrice: params.entryPrice,
            stopLoss: params.stopLoss,
            takeProfit: params.takeProfit,
            side: params.side,
            targetProfitPercent: params.targetProfitPercent,
            atr: params.atr,
            minRiskRewardRatio: params.minRiskRewardRatio,
          })
          return {
            success: true,
            data,
            metadata: { source: "deterministic", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "deterministic", latencyMs: Date.now() - start },
          }
        }
      },
    },
  ]
}
