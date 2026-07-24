/**
 * @file sentiment/index.ts
 * @description Builds and returns the sentiment tool registry with all available sentiment tools.
 * @module tools/sentiment
 * @layer util
 */

import type { ToolRegistry } from "../types"
import { registerTools } from "../registry"
import {
  getAiSentiment,
  getNarratives,
  getTrendingTopics,
  getTwitterSentiment,
  getAiResearch,
  getNews,
} from "./cryptocurrencycv"
import { getFearGreed } from "./altme"

/**
 * @function buildSentimentRegistry
 * @description Creates an empty registry, registers all sentiment tools, and returns it.
 * @returns {ToolRegistry} The populated sentiment tool registry.
 */
export function buildSentimentRegistry(): ToolRegistry {
  const registry: ToolRegistry = {}
  registerTools(registry, [
    getAiSentiment,
    getNarratives,
    getTrendingTopics,
    getTwitterSentiment,
    getAiResearch,
    getNews,
    getFearGreed,
  ])
  return registry
}
