/**
 * @file planning/tools/index.ts
 * @description Entry point for the planning swarm tools. Builds a ToolRegistry
 * merging risk-engine and market-data tools, bound to a shared planning context.
 * @module planning/tools
 * @layer agent
 */

import type { ToolDefinition, ToolRegistry } from "@/lib/agent/tools/types"
import { registerTools } from "@/lib/agent/tools/registry"
import { buildRiskEngineTools } from "./risk-engine"
import { buildMarketDataTools } from "./market-data"

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
 * @description Builds the planning swarm ToolRegistry, merging the risk-engine
 * and market-data tool sets bound to the provided context.
 * @param {PlanningToolContext} ctx - Shared planning context (wallet, user, asset, equity).
 * @returns {ToolRegistry} Registry of deterministic planning tools.
 */
export function buildPlanningToolRegistry(ctx: PlanningToolContext): ToolRegistry {
  const registry: ToolRegistry = {}
  const tools: ToolDefinition[] = [
    ...buildRiskEngineTools(ctx),
    ...buildMarketDataTools(ctx),
    // reason: funding/liquidation/web-search tools merged by T3 (parallel task)
  ]
  registerTools(registry, tools)
  return registry
}
