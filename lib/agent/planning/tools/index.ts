/**
 * @file planning/tools/index.ts
 * @description Entry point for the planning swarm tools. Builds a ToolRegistry
 * merging risk-engine, feasibility, market-data, funding, liquidation, and
 * web-search tools, bound to a shared planning context.
 * @module planning/tools
 * @layer agent
 */

import type { ToolDefinition, ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import { registerTools } from "@/lib/agent/due-diligence/tools/registry"
import { buildRiskEngineTools } from "./risk-engine"
import { buildFeasibilityTools } from "./feasibility"
import { buildMarketDataTools } from "./market-data"
import { buildFundingTools } from "./funding"
import { buildLiquidationTools } from "./liquidation"
import { buildWebSearchTools } from "./web-search"

/**
 * @interface PlanningToolContext
 * @description Context shared by all planning swarm tools.
 * @property {string} walletAddress - User's wallet address (0x-prefixed).
 * @property {string} userId - User ID.
 * @property {string} asset - Default asset ticker for tools whose params omit asset.
 * @property {number} equity - Pre-fetched account equity in USDC (spec 16.4: no get_equity tool).
 * @property {number} [markPrice] - Pre-fetched mark price (same pattern as equity):
 *   tools use it as the primary source and only fetch as a fallback. One fetch
 *   per run instead of one per tool call across 3 perspectives × N calls.
 * @property {number} [atr] - Pre-fetched 1h ATR(14) for the asset; compute_atr
 *   with the default period serves it from context instead of re-fetching.
 */
export interface PlanningToolContext {
  walletAddress: string
  userId: string
  asset: string
  equity: number
  markPrice?: number
  atr?: number
}

/**
 * @function buildPlanningToolRegistry
 * @description Builds the planning swarm ToolRegistry, merging the risk-engine,
 * feasibility, market-data, funding, liquidation, and web-search tool sets
 * bound to the provided context.
 * @param {PlanningToolContext} ctx - Shared planning context (wallet, user, asset, equity).
 * @returns {ToolRegistry} Registry of deterministic planning tools.
 */
export function buildPlanningToolRegistry(ctx: PlanningToolContext): ToolRegistry {
  const registry: ToolRegistry = {}
  const tools: ToolDefinition[] = [
    ...buildRiskEngineTools(ctx),
    ...buildFeasibilityTools(),
    ...buildMarketDataTools(ctx),
    ...buildFundingTools(ctx),
    ...buildLiquidationTools(ctx),
    ...buildWebSearchTools(ctx),
  ]
  registerTools(registry, tools)
  return registry
}
