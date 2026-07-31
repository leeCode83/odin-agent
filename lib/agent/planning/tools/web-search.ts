/**
 * @file planning/tools/web-search.ts
 * @description Exa web-search tool for the planning swarm. Lets perspective
 * subagents validate theses against recent news and macro events. Requires
 * EXA_API_KEY; missing key fails fast without a network call so the subagent
 * can continue with the remaining tools.
 * @module planning/tools/web-search
 * @layer agent
 */

import { z } from "zod"
import type { ToolDefinition } from "@/lib/agent/tools/types"
import { withTimeout } from "@/lib/utils"

/**
 * @interface WebSearchToolContext
 * @description Context passed to the web-search tool builder. Reserved for
 * orchestrator pattern parity; web search takes query per call and does not
 * use ctx.
 * @property {string} walletAddress - User wallet address.
 * @property {string} userId - User identifier.
 * @property {string} asset - Default asset ticker (unused; tools take query per call).
 * @property {number} equity - Account equity in USDC (unused).
 */
export interface WebSearchToolContext {
  walletAddress: string
  userId: string
  asset: string
  equity: number
}

/**
 * @constant EXA_SEARCH_URL
 * @description Exa search API endpoint.
 */
const EXA_SEARCH_URL = "https://api.exa.ai/search"

/**
 * @constant EXA_TIMEOUT_MS
 * @description Hard timeout for the Exa request — the tool must fail fast so
 * the subagent loop is not blocked.
 */
const EXA_TIMEOUT_MS = 15_000

/**
 * @constant EXA_NUM_RESULTS
 * @description Number of results requested per search.
 */
const EXA_NUM_RESULTS = 5

/**
 * @interface ExaResult
 * @description A single search result as returned by the Exa API.
 * @property {string} [title] - Result title.
 * @property {string} [url] - Result URL.
 * @property {string} [text] - Result text excerpt.
 */
interface ExaResult {
  title?: string
  url?: string
  text?: string
}

/**
 * @function buildWebSearchTools
 * @description Builds the Exa web-search tool.
 * @param {WebSearchToolContext} _ctx - Context (unused; tools take query per call).
 * @returns {ToolDefinition[]} web_search.
 */
export function buildWebSearchTools(_ctx: WebSearchToolContext): ToolDefinition[] {
  // reason: ctx reserved for orchestrator pattern parity; web search takes query per call
  void _ctx
  return [
    {
      name: "web_search",
      description:
        "Search the web for recent news, sentiment, and macro events relevant to a trading decision. " +
        "Returns up to 5 results with title, url, and text excerpt. Requires EXA_API_KEY.",
      parameters: z.object({
        query: z.string().min(1).describe("Search query, e.g. 'BTC news today'"),
      }),
      execute: async (params) => {
        const start = Date.now()
        const key = process.env.EXA_API_KEY
        if (!key) {
          // reason: fail fast without a network call; subagent continues with remaining tools
          return {
            success: false,
            error: "EXA_API_KEY not configured",
            metadata: { source: "exa", latencyMs: Date.now() - start },
          }
        }
        try {
          const res = await withTimeout(
            fetch(EXA_SEARCH_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
              },
              body: JSON.stringify({ query: params.query, numResults: EXA_NUM_RESULTS }),
            }),
            EXA_TIMEOUT_MS
          )
          if (!res.ok) {
            throw new Error(`Exa search failed: HTTP ${res.status}`)
          }
          const data = (await res.json()) as { results?: ExaResult[] }
          const results = (data.results ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            text: r.text ?? "",
          }))
          return {
            success: true,
            data: { results },
            metadata: { source: "exa", latencyMs: Date.now() - start },
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            metadata: { source: "exa", latencyMs: Date.now() - start },
          }
        }
      },
    },
  ]
}
