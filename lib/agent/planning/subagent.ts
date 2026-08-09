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
import type { SubAgentThought, LlmThinkMessage, ThinkResult } from "@/lib/agent/due-diligence/subagent"
import { runSubagent } from "@/lib/agent/due-diligence/subagent"
import { think } from "@/lib/agent/due-diligence/llm"
import { makePlanningSystemPrompt } from "@/lib/agent/planning/prompts"
import { compactDDReport } from "@/lib/agent/planning/utils"
import { extractDegradedFactors } from "@/lib/agent/shared/dd-utils"

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
    messages: LlmThinkMessage[]
  ): Promise<ThinkResult> => {
    // reason: runSubagent's context message carries only factor/asset/instruction/history —
    // the DDReport is appended here so every THINK call sees it. Native tools are NOT
    // forwarded (the 2nd options arg is intentionally dropped) — planning stays on the
    // JSON-in-prompt convention, which T6 leaves untouched for non-DD callers.
    const withReport: LlmThinkMessage[] = [
      ...messages,
      { role: "user", content: `[DDReport]\n${JSON.stringify(compactDDReport(params.ddReport))}` },
    ]
    const thought = await think(withReport)
    if (thought.action === "return") stash = thought
    return thought
  }

  const report = await runSubagent({
    factor: params.perspective,
    tools: params.tools,
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

  return {
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
}
