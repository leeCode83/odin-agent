/**
 * @file tools/registry.ts
 * @description Registry for managing tool definitions accessible to DD subagents.
 * @module tools
 * @layer util
 */

import type { ToolDefinition, ToolRegistry } from "./types"

const KNOWN_FACTORS = ["technical", "onchain", "sentiment", "fundamental"] as const

/** Internal store for cross-factor tools, populated by registerCrossFactorTools. */
let crossFactorStore: ToolRegistry = {}

/**
 * @function getToolRegistry
 * @description Returns the tool registry for a given factor. Throws if factor is unknown.
 * @param {string} factor - The factor name.
 * @returns {ToolRegistry} The factor's tool registry (initially empty).
 */
export function getToolRegistry(factor: string): ToolRegistry {
  if (!KNOWN_FACTORS.includes(factor as typeof KNOWN_FACTORS[number])) {
    throw new Error(`Unknown factor: ${factor}`)
  }
  return {}
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
