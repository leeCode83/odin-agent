/**
 * @file tools/fundamental/index.ts
 * @description Builds and returns the fundamental factor's tool registry by registering all CoinGecko and PublicDrop tools.
 * @module tools/fundamental
 */

import type { ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import { registerTools } from "@/lib/agent/due-diligence/tools/registry"
import { coingeckoMetadataTools } from "./coingecko-metadata"
import { publicDropTools } from "./publicdrop"

/**
 * @function buildFundamentalRegistry
 * @description Creates an empty registry, registers all fundamental tools (CoinGecko + PublicDrop), and returns it.
 * @returns {ToolRegistry} The populated fundamental tool registry.
 */
export function buildFundamentalRegistry(): ToolRegistry {
  const registry: ToolRegistry = {}
  registerTools(registry, coingeckoMetadataTools)
  registerTools(registry, publicDropTools)
  return registry
}
