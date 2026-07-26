/**
 * @file tools/registry.ts
 * @description Registry for managing tool definitions accessible to DD subagents.
 * @module tools
 * @layer util
 */

import type { ToolDefinition, ToolRegistry } from "./types"
import type { CandleMap } from "./technical/candles"
import { buildTechnicalRegistry } from "./technical"
import { buildOnchainRegistry } from "./onchain"
import { buildSentimentRegistry } from "./sentiment"
import { buildFundamentalRegistry } from "./fundamental"

const KNOWN_FACTORS = ["technical", "onchain", "sentiment", "fundamental"] as const

/** Internal store for cross-factor tools, populated by registerCrossFactorTools. */
let crossFactorStore: ToolRegistry = {}

/**
 * @function getToolRegistry
 * @description Returns the tool registry for a given factor. Throws if factor is unknown.
 *   Technical factor requires an optional CandleMap context — without it, returns empty registry.
 *   All other factors build their registries synchronously.
 * @param {string} factor - The factor name.
 * @param {{ candleMap?: CandleMap }} [ctx] - Optional context (CandleMap for technical tools).
 * @returns {ToolRegistry} The factor's populated tool registry.
 */
export function getToolRegistry(factor: string, ctx?: { candleMap?: CandleMap }): ToolRegistry {
  if (!KNOWN_FACTORS.includes(factor as typeof KNOWN_FACTORS[number])) {
    throw new Error(`Unknown factor: ${factor}`)
  }
  switch (factor) {
    case "technical":
      return ctx?.candleMap ? buildTechnicalRegistry(ctx.candleMap) : {}
    case "onchain":
      return buildOnchainRegistry()
    case "sentiment":
      return buildSentimentRegistry()
    case "fundamental":
      return buildFundamentalRegistry()
    default:
      return {}
  }
}

/**
 * @function registerCrossFactorTools
 * @description Registers a set of factor tools into the cross-factor registry,
 * making them available to the Main Agent for cross-verification between factors.
 * Idempotent — calling with the same tools overwrites by name.
 * @param {ToolRegistry} registry - The factor's tool registry to merge into the cross-factor store.
 * @returns {void}
 */
export function registerCrossFactorTools(registry: ToolRegistry): void {
  for (const [name, tool] of Object.entries(registry)) {
    crossFactorStore[name] = tool
  }
}

/**
 * @function resetCrossFactorRegistry
 * @description Clears the cross-factor tool store. Intended for testing and teardown.
 * @returns {void}
 */
export function resetCrossFactorRegistry(): void {
  crossFactorStore = {}
}

/**
 * @function getCrossFactorRegistry
 * @description Returns the cross-factor tool registry (tools available across all factors).
 * Populated by calling registerCrossFactorTools for each factor's tools.
 * @returns {ToolRegistry} The cross-factor registry.
 */
export function getCrossFactorRegistry(): ToolRegistry {
  return crossFactorStore
}

/**
 * @function registerTools
 * @description Registers tools into a registry by name. Mutates the registry in place.
 * @param {ToolRegistry} registry - The registry to mutate.
 * @param {ToolDefinition[]} tools - Tools to register.
 * @returns {void}
 */
export function registerTools(registry: ToolRegistry, tools: ToolDefinition[]): void {
  for (const tool of tools) {
    registry[tool.name] = tool
  }
}
