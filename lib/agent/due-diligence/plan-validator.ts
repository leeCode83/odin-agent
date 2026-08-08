/**
 * @file plan-validator.ts
 * @module due-diligence
 * @layer service
 * @description Code-side enforcement for subagent deployment rules. Complements the
 *   DEPLOYMENT_RULES prompt (prompts.ts): sanitizes LLM plan output so only the four
 *   valid factors survive, dedupes per factor, and forces technical + onchain presence.
 */
import { FACTOR_KEYS, SubagentPlanSchema, type SubagentPlan } from "./types"
import { createDdLogger } from "./logger"
import { parseLlmJson } from "@/lib/agent/shared/json-utils"

const log = createDdLogger({ module: "plan-validator" })

/**
 * @constant DEFAULT_INSTRUCTIONS
 * @description Fallback instructions for the mandatory factors when the LLM omits them.
 *   Mirrors the few-shot examples in PLAN_PROMPT so the pipeline still has a runnable plan.
 */
export const DEFAULT_INSTRUCTIONS: Record<"technical" | "onchain", string> = {
  technical: "Use get_atr to verify current volatility and check RSI divergence on the 1h chart.",
  onchain: "Use get_whale_txns to check whale wallet movements in the last 24h, then get_exchange_flow to verify exchange inflows.",
}

/**
 * @function sanitizePlans
 * @description Sanitizes raw LLM plan output into a valid SubagentPlan[]:
 *   validates every item against SubagentPlanSchema (drops invalid ones),
 *   dedupes per factor keeping the best priority, appends the mandatory
 *   technical and onchain factors when missing, and sorts by priority.
 * @param {unknown[]} items - Raw parsed plan array from the LLM.
 * @param {"plan" | "replan"} logPrefix - Logger event prefix ("plan" or "replan").
 * @returns {SubagentPlan[]} Sanitized, deduped, mandatory-complete, priority-sorted plans.
 */
export function sanitizePlans(items: unknown[], logPrefix: "plan" | "replan"): SubagentPlan[] {
  // reason: empty input stays empty — an empty LLM response means failure/unavailability,
  // not omission, so the pipeline must handle it (agent.ts early-exit) instead of
  // receiving fabricated default instructions.
  if (items.length === 0) return []

  const byFactor = new Map<string, SubagentPlan>()

  for (const item of items) {
    const result = SubagentPlanSchema.safeParse(item)
    if (!result.success) {
      log("warn", `${logPrefix}_invalid_item_dropped`, { factor: (item as { factor?: unknown })?.factor, error: result.error.message })
      continue
    }
    const existing = byFactor.get(result.data.factor)
    // reason: best priority wins — lower number = higher priority
    if (!existing || result.data.priority < existing.priority) {
      byFactor.set(result.data.factor, result.data)
    }
  }

  for (const factor of FACTOR_KEYS) {
    if (factor === "technical" || factor === "onchain") {
      if (!byFactor.has(factor)) {
        byFactor.set(factor, {
          factor,
          instruction: DEFAULT_INSTRUCTIONS[factor],
          priority: factor === "technical" ? 1 : 2,
        })
      }
    }
  }

  return [...byFactor.values()].sort((a, b) => a.priority - b.priority)
}

/**
 * @function parsePlanOutput
 * @description Parses raw LLM content into sanitized plans. JSON parse failure
 *   returns [] (pipeline handles it); success delegates to sanitizePlans.
 * @param {string} content - Raw LLM response content.
 * @param {"plan" | "replan"} logPrefix - Logger event prefix ("plan" or "replan").
 * @returns {SubagentPlan[]} Sanitized plans, or [] when unparseable.
 */
export function parsePlanOutput(content: string, logPrefix: "plan" | "replan"): SubagentPlan[] {
  const parsed = parseLlmJson(content)
  if (parsed === null || !Array.isArray(parsed)) {
    log("warn", `${logPrefix}_json_unparseable`, { rawPrefix: content.slice(0, 300) })
    return []
  }
  return sanitizePlans(parsed, logPrefix)
}
