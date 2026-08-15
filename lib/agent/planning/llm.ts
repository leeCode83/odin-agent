/**
 * @file planning/llm.ts
 * @description DeepSeek-backed LLM calls for the planning swarm AGGREGATE step.
 *   The LLM is only allowed to return narrative: side, thesis, reasoning,
 *   risk_flags_text, consensus_alignment, and contradictions. Every numeric
 *   field of the final trade (entry/SL/TP/size/leverage/confidence) is computed
 *   deterministically in code — the aggregator schema rejects money numbers, so
 *   an LLM-guessed value can never survive into a trade plan. The orchestrator
 *   PLAN/RE-PLAN step is deterministic (buildFixedPerspectives) and has no LLM
 *   counterpart here anymore.
 * @module planning
 * @layer service
 */

import OpenAI from "openai"
import { z } from "zod"
import type { PlanningAggregationLlmResult, PerspectiveReport } from "./types"
import type { DDReport } from "@/lib/agent/types"
import { AGGREGATE_PROMPT, buildDDFactorContext } from "./prompts"
import { compactDDReport } from "./utils"
import { getClient, DEEPSEEK_BASE_URL, DEEPSEEK_THINK_MODEL } from "@/lib/agent/shared/llm-client"

export { getClient, DEEPSEEK_BASE_URL, DEEPSEEK_THINK_MODEL }

type ThinkingParams = { thinking: { type: string }; reasoning_effort: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function thinkingParams(): ThinkingParams & Record<string, any> {
  return { thinking: { type: "enabled" }, reasoning_effort: DEEPSEEK_REASONING_EFFORT }
}

const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high"

// reason: planning orchestrator/aggregator calls run in thinking mode — DeepSeek
// rejects `temperature` there, so it is omitted entirely.
const PLANNING_TIMEOUT_MS = 60_000
const PLANNING_MAX_RETRIES = 1


/**
 * @function clamp
 * @description Returns a clamp function bounding a number to [min, max].
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {(value: number) => number} Clamping transform.
 */
function clamp(min: number, max: number): (value: number) => number {
  return (value: number) => Math.min(max, Math.max(min, value))
}

/**
 * @constant PlanningAggregationSanitizeSchema
 * @description Zod schema used to sanitize the aggregator's raw LLM output into
 *   a `PlanningAggregationLlmResult`. Only narrative survives: `side` is
 *   validated against the enum (invalid side rejects the whole result), numeric
 *   money fields are deliberately ABSENT (zod strips unknown keys, so any price
 *   or size the LLM invents is dropped), and missing optional fields fall back
 *   to defaults. `consensus_alignment` is the one bounded number kept — a 0-100
 *   alignment gauge, not a trade number.
 */
const PlanningAggregationSanitizeSchema = z.object({
  side: z.enum(["long", "short", "no_trade"]),
  thesis: z.string().default(""),
  reasoning: z.string().default(""),
  risk_flags_text: z.string().default(""),
  consensus_alignment: z.number().transform(clamp(0, 100)).default(0),
  contradictions: z.array(z.string()).default([]),
  no_trade_reason: z.string().optional(),
})

/**
 * @function sanitizeAggregation
 * @description Sanitizes raw aggregator output into a `PlanningAggregationLlmResult`,
 *   or returns null if the shape is unusable (invalid side, wrong top-level type).
 * @param {unknown} raw - Raw parsed LLM output.
 * @returns {PlanningAggregationLlmResult | null} Sanitized result or null.
 */
function sanitizeAggregation(raw: unknown): PlanningAggregationLlmResult | null {
  const parsed = PlanningAggregationSanitizeSchema.safeParse(raw)
  if (!parsed.success) {
    console.error("[Planning:aggregate] Schema validation failed:", parsed.error.message)
    return null
  }
  return parsed.data
}

/**
 * @function callPlanningLLM
 * @description Shared LLM call for the orchestrator/aggregator (deepseek-v4-pro,
 *   thinking mode — no temperature, json_object, 8192 max tokens, 60s timeout,
 *   retry 1). Failures and parse errors fall back to the caller's `fallback`.
 * @param {Object} options - Call options.
 * @param {string} options.phase - Log prefix (e.g. "aggregate").
 * @param {string} options.systemPrompt - System prompt constant.
 * @param {string} options.userContent - Serialized user payload.
 * @param {(raw: unknown) => T} options.parse - Sanitizer for the parsed JSON.
 * @param {T} options.fallback - Value returned on any failure.
 * @returns {Promise<T>} Sanitized result or fallback.
 */
async function callPlanningLLM<T>(options: {
  phase: string
  systemPrompt: string
  userContent: string
  parse: (raw: unknown) => T
  fallback: T
}): Promise<T> {
  const c = getClient()
  if (!c) return options.fallback

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_THINK_MODEL,
        max_tokens: 8192,
        response_format: { type: "json_object" },
        ...thinkingParams(),
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userContent },
        ],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { timeout: PLANNING_TIMEOUT_MS, maxRetries: PLANNING_MAX_RETRIES }
    )
    const content = response.choices?.[0]?.message?.content || "{}"
    return options.parse(JSON.parse(content))
  } catch (err) {
    console.error(`[Planning:${options.phase}] LLM call failed:`, err instanceof Error ? err.message : String(err))
    return options.fallback
  }
}

/**
 * @function aggregate
 * @description Orchestrator AGGREGATE step (spec §7.4): merges the three
 *   PerspectiveReports into narrative consensus (side, thesis, reasoning,
 *   contradictions). The output carries NO money numbers — the orchestrator
 *   computes confidence via deterministicConfidence and the trade numbers via
 *   computeTradeNumbers from tool results, so `profit_feasible` is decided there
 *   too. Output is sanitized (`side` validated against the enum).
 * @param {Object} params - Aggregate parameters.
 * @param {PerspectiveReport[]} params.reports - Perspective subagent reports.
 * @param {DDReport} params.ddReport - Due diligence report from the DD agent.
 * @param {number} params.targetProfitPercent - User's profit target.
 * @returns {Promise<PlanningAggregationLlmResult | null>} Sanitized narrative
 *   aggregation, or null on failure.
 */
export async function aggregate(params: {
  reports: PerspectiveReport[]
  ddReport: DDReport
  targetProfitPercent: number
}): Promise<PlanningAggregationLlmResult | null> {
  const compact = compactDDReport(params.ddReport)
  return callPlanningLLM({
    phase: "aggregate",
    systemPrompt: AGGREGATE_PROMPT,
    userContent: JSON.stringify({
      reports: params.reports,
      ddReport: compact,
      factorCoverageContext: buildDDFactorContext(compact),
      targetProfitPercent: params.targetProfitPercent,
    }),
    parse: sanitizeAggregation,
    fallback: null,
  })
}
