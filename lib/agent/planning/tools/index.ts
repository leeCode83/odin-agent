/**
 * @file planning/tools/index.ts
 * @description Entry point for the planning swarm tools. Builds a ToolRegistry
 * merging risk-engine, market-data, funding, liquidation, and web-search tools,
 * bound to a shared planning context.
 * @module planning/tools
 * @layer agent
 */

import type { ToolDefinition, ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import { registerTools } from "@/lib/agent/due-diligence/tools/registry"
import { buildRiskEngineTools } from "./risk-engine"
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
 */
export interface PlanningToolContext {
  walletAddress: string
  userId: string
  asset: string
  equity: number
}

/**
 * @function buildPlanningToolRegistry
 * @description Builds the planning swarm ToolRegistry, merging the risk-engine,
 * market-data, funding, liquidation, and web-search tool sets bound to the
 * provided context.
 * @param {PlanningToolContext} ctx - Shared planning context (wallet, user, asset, equity).
 * @returns {ToolRegistry} Registry of deterministic planning tools.
 */
export function buildPlanningToolRegistry(ctx: PlanningToolContext): ToolRegistry {
  const registry: ToolRegistry = {}
  const tools: ToolDefinition[] = [
    ...buildRiskEngineTools(ctx),
    ...buildMarketDataTools(ctx),
    ...buildFundingTools(ctx),
    ...buildLiquidationTools(ctx),
    ...buildWebSearchTools(ctx),
  ]
  registerTools(registry, tools)
  return registry
}
