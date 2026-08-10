/**
 * @file planning/subagent.ts
 * @description Thin wrapper around the DD `runSubagent()` ReAct loop for the
 *   planning swarm's perspective subagents. No new loop code — this file only
 *   wires the planning-specific LLM think function, system prompt, and the
 *   stash-and-merge of planning fields (side, entry_price, suggested_*,
 *   risk_flags) that `FactorReport` does not carry.
 * @module planning
 * @layer service
 */

import type { DDReport } from "@/lib/agent/types"
import type { ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import type { Perspective, PerspectiveReport } from "@/lib/agent/planning/types"
import type { SubAgentThought, LlmThinkMessage, ThinkOptions, ThinkResult } from "@/lib/agent/due-diligence/subagent"
import { runSubagent } from "@/lib/agent/due-diligence/subagent"
import { think } from "@/lib/agent/due-diligence/llm"
import { makePlanningSystemPrompt, buildDDFactorContext } from "@/lib/agent/planning/prompts"
import { verifyReportAgainstTools } from "@/lib/agent/planning/verifier"
import { compactDDReport } from "@/lib/agent/planning/utils"
import { extractDegradedFactors } from "@/lib/agent/shared/dd-utils"

/**
 * @constant TOOL_PRIORITY
 * @description Per-perspective tool ordering for the planning subagent prompt
 *   (real registry tool names from lib/agent/planning/tools/*): conservative
 *   leads with risk-engine + funding/liquidation tools (validate downside
 *   first), aggressive leads with market data + web search (opportunity
 *   first), balance interleaves market data and risk tools.
 */
export const TOOL_PRIORITY: Record<Perspective, string[]> = {
  conservative: [
    "compute_atr",
    "compute_sltp",
    "compute_position_size",
    "analyze_funding_regime",
    "detect_oi_funding_divergence",
    "check_liquidation_zones",
    "assess_cascade_risk",
    "get_mark_price",
    "get_candles",
    "get_risk_thresholds",
    "get_graph_patterns",
    "get_orderbook_depth",
    "web_search",
  ],
  aggressive: [
    "get_mark_price",
    "get_candles",
    "get_risk_thresholds",
    "get_graph_patterns",
    "get_orderbook_depth",
    "web_search",
    "analyze_funding_regime",
    "detect_oi_funding_divergence",
    "check_liquidation_zones",
    "assess_cascade_risk",
    "compute_atr",
    "compute_sltp",
    "compute_position_size",
  ],
  balance: [
    "get_mark_price",
    "get_candles",
    "get_risk_thresholds",
    "get_graph_patterns",
    "get_orderbook_depth",
    "compute_atr",
    "compute_sltp",
    "compute_position_size",
    "web_search",
    "analyze_funding_regime",
    "detect_oi_funding_divergence",
    "check_liquidation_zones",
    "assess_cascade_risk",
  ],
}

/**
 * @function orderToolsByPriority
 * @description Orders a registry tool-name list by the perspective's
 *   TOOL_PRIORITY: priority-listed names first (in priority order, absent
 *   ones skipped), then unlisted names in their original relative order —
 *   tools are never dropped.
 * @param {string[]} tools - Tool names from the planning registry.
 * @param {Perspective} perspective - The perspective to order for.
 * @returns {string[]} Reordered tool names.
 */
export function orderToolsByPriority(tools: string[], perspective: Perspective): string[] {
  const priority = TOOL_PRIORITY[perspective]
  const prioritySet = new Set(priority)
  const ordered = priority.filter((name) => tools.includes(name))
  // reason: never drop tools — unlisted registry tools keep their relative order after the priority ones
  return [...ordered, ...tools.filter((name) => !prioritySet.has(name))]
}

/**
 * @function runPerspectiveSubagent
 * @description Runs one planning perspective subagent (conservative/balance/aggressive)
 *   through the DD ReAct loop.
 *
 *   Wiring:
 *   - `llmThink`: closure over `ddReport` — appends the serialized DDReport to the
 *     context messages, calls DD `think()`, and stashes any `return` thought so its
 *     planning fields survive zod's stripping. Returns the thought to `runSubagent`
 *     unchanged.
 *   - `getSystemPrompt`: `makePlanningSystemPrompt({ targetProfitPercent })` composed
 *     with (perspective, tools, instruction). When the DD report is partial
 *     (some factorReports have score null/missing), the failed factor names are
 *     passed in so the prompt carries the degraded-DD note (F3).
 *   - The `FactorReport` returned by `runSubagent` is merged with the stashed
 *     planning fields; missing extras fall back to defaults (`no_trade`, 0, []).
 *   - The merged report then passes through `verifyReportAgainstTools` (T13):
 *     the tool ledger (`factor.toolHistory`) hard-enforces entry price from
 *     `get_mark_price` and overrides SL/TP/size from the risk-engine tools.
 * @param {Object} params - Perspective subagent configuration.
 * @param {Perspective} params.perspective - The perspective to emulate.
 * @param {string} params.instruction - Orchestrator instruction scoping the analysis.
 * @param {string} params.asset - Asset ticker.
 * @param {DDReport} params.ddReport - Due diligence report the perspective validates.
 * @param {number} params.targetProfitPercent - User's profit target (e.g. 100 = 100%).
 * @param {ToolRegistry} params.tools - Planning tool registry.
 * @returns {Promise<PerspectiveReport>} Merged perspective report.
 */
export async function runPerspectiveSubagent(params: {
  perspective: Perspective
  instruction: string
  asset: string
  ddReport: DDReport
  targetProfitPercent: number
  tools: ToolRegistry
}): Promise<PerspectiveReport> {
  // reason: degraded-DD signaling (F3) — factor reports with score null or
  // missing count as failed; the names reach the perspective's system prompt
  // so the LLM accounts for the missing analysis instead of treating a
  // data-starved NO_TRADE as real market conviction.
  const degradedFactors = extractDegradedFactors(params.ddReport.factorReports ?? [])
  // reason: zod strips unknown keys in SubAgentThoughtSchema — the only way the
  // wrapper can see side/entry_price/suggested_*/risk_flags is to stash the parsed
  // return thought here before runSubagent discards it.
  let stash: Extract<SubAgentThought, { action: "return" }> | undefined

  const llmThink = async (
    messages: LlmThinkMessage[],
    options?: ThinkOptions
  ): Promise<ThinkResult> => {
    // reason: runSubagent's context message carries only factor/asset/instruction/history —
    // the DDReport is appended here so every THINK call sees it. The 2nd options arg
    // (native OpenAI tools built from the planning registry) is forwarded to DD think()
    // so the LLM gets native tool calling instead of JSON-in-prompt; runSubagent passes
    // undefined when the registry is empty, keeping the JSON convention for that case.
    const compact = compactDDReport(params.ddReport)
    // reason: focus-aware factor context (contract with prompts.ts) — conservative
    // hones on risk factors, aggressive on market factors, balance on the full
    // picture (single-arg call, no focus).
    const focus: "risk" | "market" | undefined =
      params.perspective === "conservative" ? "risk" : params.perspective === "aggressive" ? "market" : undefined
    const factorContext = focus === undefined ? buildDDFactorContext(compact) : buildDDFactorContext(compact, focus)
    const withReport: LlmThinkMessage[] = [
      ...messages,
      { role: "user", content: `[DDReport]\n${JSON.stringify(compact)}\n${factorContext}` },
    ]
    const thought = await think(withReport, options)
    if (thought.action === "return") stash = thought
    return thought
  }

  // reason: perspective-specific tool emphasis — reorder the registry by
  // TOOL_PRIORITY so both the system-prompt tool list and the native tools
  // (Object.entries/Object.values insertion order in runSubagent) lead with
  // the perspective's preferred tools; unlisted tools are appended, never dropped.
  const orderedTools = Object.fromEntries(
    orderToolsByPriority(Object.keys(params.tools), params.perspective).map((name) => [name, params.tools[name]])
  ) as ToolRegistry

  const report = await runSubagent({
    factor: params.perspective,
    tools: orderedTools,
    instruction: params.instruction,
    asset: params.asset,
    maxLoops: 5,
    timeoutMs: 60000,
    llmThink,
    getSystemPrompt: makePlanningSystemPrompt({
      targetProfitPercent: params.targetProfitPercent,
      degradedFactors: degradedFactors.length > 0 ? degradedFactors : undefined,
    }),
  })

  const merged: PerspectiveReport = {
    perspective: params.perspective,
    score: report.score,
    confidence: report.confidence,
    side: stash?.side ?? "no_trade",
    entry_price: stash?.entry_price ?? 0,
    signals: report.signals,
    dataSources: report.dataSources,
    reasoning: report.reasoning,
    iterations: report.iterations,
    conclusion: report.conclusion,
    errors: report.errors,
    suggested_stop_loss: stash?.suggested_stop_loss ?? 0,
    suggested_take_profit: stash?.suggested_take_profit ?? 0,
    suggested_position_size_usdc: stash?.suggested_position_size_usdc ?? 0,
    risk_flags: stash?.risk_flags ?? [],
  }

  // reason: T13 hard-enforcement — the LLM's trading numbers are reconciled
  // against the actual tool results (entry must come from get_mark_price, SL/TP
  // and size from the risk-engine tools). runSubagent surfaces the ledger via
  // factor.toolHistory; undefined (score-null force returns) degrades to [].
  return verifyReportAgainstTools(merged, report.toolHistory ?? [])
}
