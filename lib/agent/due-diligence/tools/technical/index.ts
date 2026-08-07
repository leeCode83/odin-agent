/**
 * @file tools/technical/index.ts
 * @description Entry point for the technical tools module. Builds a ToolRegistry
 * containing all 13 indicator tools, initialized with a pre-fetched CandleMap.
 * @module tools/technical
 * @layer util
 */

import type { ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import { registerTools } from "@/lib/agent/due-diligence/tools/registry"
import type { CandleMap } from "./candles"
import { buildIndicators } from "./indicators"

/**
 * @function buildTechnicalRegistry
 * @description Creates a ToolRegistry for the technical factor by building all
 * indicator tools against the provided CandleMap and registering them.
 * @param {CandleMap} candleMap - Pre-fetched candle data keyed by timeframe.
 * @returns {ToolRegistry} Registry of 13 technical analysis tools.
 */
export function buildTechnicalRegistry(candleMap: CandleMap): ToolRegistry {
  const registry: ToolRegistry = {}
  const tools = buildIndicators(candleMap)
  registerTools(registry, tools)
  return registry
}
