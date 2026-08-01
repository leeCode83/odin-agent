import OpenAI from "openai"
import { z } from "zod"
import { PerspectiveSchema } from "./types"
import type { Perspective, PlanningSubagentPlan, PlanningAggregationResult, PerspectiveReport } from "./types"
import type { DDReport } from "@/lib/agent/types"
import { PLAN_PROMPT, AGGREGATE_PROMPT, REPLAN_PROMPT } from "./prompts"

type ThinkingParams = { thinking: { type: string }; reasoning_effort: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function thinkingParams(): ThinkingParams & Record<string, any> {
  return { thinking: { type: "enabled" }, reasoning_effort: DEEPSEEK_REASONING_EFFORT }
}

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
const DEEPSEEK_THINK_MODEL = process.env.DEEPSEEK_THINK_MODEL || "deepseek-v4-pro"
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high"

// reason: planning orchestrator/aggregator calls run in thinking mode — DeepSeek
// rejects `temperature` there, so it is omitted entirely.
const PLANNING_TIMEOUT_MS = 60_000
const PLANNING_MAX_RETRIES = 1

let client: OpenAI | null = null

/**
 * @function getClient
 * @description Creates or returns cached OpenAI client configured for DeepSeek.
 * Reads DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL from env.
 * @returns {OpenAI | null} OpenAI client or null if no API key configured.
 */
function getClient(): OpenAI | null {
  if (!process.env.DEEPSEEK_API_KEY) return null
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: DEEPSEEK_BASE_URL,
    })
  }
  return client
}

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
 *   a `PlanningAggregationResult`. Bounded numbers clamp to 0-100, `side` is
 *   validated against the enum (invalid side rejects the whole result), and
 *   missing optional fields fall back to defaults.
 */
const PlanningAggregationSanitizeSchema = z.object({
  side: z.enum(["long", "short", "no_trade"]),
  thesis: z.string().default(""),
  reasoning: z.string().default(""),
  confidence_score: z.number().transform(clamp(0, 100)).default(0),
  confidence_breakdown: z
    .object({
      factor_alignment: z.number().transform(clamp(0, 100)).default(0),
      historical_match: z.number().transform(clamp(0, 100)).default(0),
      signal_strength: z.number().transform(clamp(0, 100)).default(0),
    })
    .default({ factor_alignment: 0, historical_match: 0, signal_strength: 0 }),
  // reason: leverage has its own semantic range (1-20 per the prompt), not 0-100.
  leverage_suggested: z.number().transform(clamp(1, 20)).default(1),
  risk_flags: z.array(z.string()).default([]),
  consensus_alignment: z.number().transform(clamp(0, 100)).default(0),
  contradictions: z.array(z.string()).default([]),
  profit_feasible: z.boolean().default(false),
  no_trade_reason: z.string().optional(),
  // reason: prices/position are bounded below only — 0-100 clamping would destroy real values.
  entry_price: z.number().transform(clamp(0, Number.MAX_SAFE_INTEGER)).default(0),
  stop_loss: z.number().transform(clamp(0, Number.MAX_SAFE_INTEGER)).default(0),
  take_profit: z.number().transform(clamp(0, Number.MAX_SAFE_INTEGER)).default(0),
  position_size_usdc: z.number().transform(clamp(0, Number.MAX_SAFE_INTEGER)).default(0),
})

/**
 * @function sanitizePlans
 * @description Sanitizes raw orchestrator PLAN/REPLAN output into
 *   `PlanningSubagentPlan[]`: accepts either a bare array or a `{ subagents }`
 *   object, keeps only valid perspectives, dedupes (first occurrence wins),
 *   clamps priority to 1-3, and coerces instructions to strings.
 * @param {unknown} raw - Raw parsed LLM output.
 * @returns {PlanningSubagentPlan[]} Sanitized plans.
 */
function sanitizePlans(raw: unknown): PlanningSubagentPlan[] {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(raw)
    ? raw
    : record && Array.isArray(record.subagents)
      ? record.subagents
      : null
  if (!list) return []

  const seen = new Set<Perspective>()
  const plans: PlanningSubagentPlan[] = []
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    const rec = item as Record<string, unknown>
    const perspective = PerspectiveSchema.safeParse(rec.perspective)
    if (!perspective.success) continue
    if (seen.has(perspective.data)) continue
    seen.add(perspective.data)
    const priority = typeof rec.priority === "number" ? Math.min(3, Math.max(1, Math.round(rec.priority))) : 3
    plans.push({
      perspective: perspective.data,
      instruction: typeof rec.instruction === "string" ? rec.instruction : "",
      priority,
    })
  }
  return plans
}

/**
 * @function sanitizeAggregation
 * @description Sanitizes raw aggregator output into a `PlanningAggregationResult`,
 *   or returns null if the shape is unusable (invalid side, wrong top-level type).
 * @param {unknown} raw - Raw parsed LLM output.
 * @returns {PlanningAggregationResult | null} Sanitized result or null.
 */
function sanitizeAggregation(raw: unknown): PlanningAggregationResult | null {
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
 * @param {string} options.phase - Log prefix (e.g. "plan", "aggregate").
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
 * @function plan
 * @description Orchestrator PLAN step (spec §7.3): decides which perspectives to
 *   deploy, their instructions, and priorities, given the DDReport and the user's
 *   profit target. Output is sanitized (valid perspectives only, deduped, priority 1-3).
 * @param {Object} params - Plan parameters.
 * @param {DDReport} params.ddReport - Due diligence report from the DD agent.
 * @param {number} params.targetProfitPercent - User's profit target (e.g. 100 = 100%).
 * @returns {Promise<PlanningSubagentPlan[]>} Sanitized subagent plans, or [] on failure.
 */
export async function plan(params: {
  ddReport: DDReport
  targetProfitPercent: number
}): Promise<PlanningSubagentPlan[]> {
  return callPlanningLLM({
    phase: "plan",
    systemPrompt: PLAN_PROMPT,
    userContent: JSON.stringify({
      ddReport: params.ddReport,
      targetProfitPercent: params.targetProfitPercent,
    }),
    parse: sanitizePlans,
    fallback: [],
  })
}

/**
 * @function rePlan
 * @description Orchestrator RE-PLAN step: generates targeted new instructions
 *   for low-consensus perspectives, informed by the previous reports.
 * @param {Object} params - Re-plan parameters.
 * @param {DDReport} params.ddReport - Due diligence report from the DD agent.
 * @param {number} params.targetProfitPercent - User's profit target.
 * @param {string[]} params.lowConsensusPerspectives - Perspectives that need re-analysis.
 * @param {PerspectiveReport[]} params.previousReports - Previous perspective reports.
 * @returns {Promise<PlanningSubagentPlan[]>} Sanitized re-deploy plans, or [] on failure.
 */
export async function rePlan(params: {
  ddReport: DDReport
  targetProfitPercent: number
  lowConsensusPerspectives: string[]
  previousReports: PerspectiveReport[]
}): Promise<PlanningSubagentPlan[]> {
  return callPlanningLLM({
    phase: "rePlan",
    systemPrompt: REPLAN_PROMPT,
    userContent: JSON.stringify({
      ddReport: params.ddReport,
      targetProfitPercent: params.targetProfitPercent,
      lowConsensusPerspectives: params.lowConsensusPerspectives,
      previousReports: params.previousReports,
    }),
    parse: sanitizePlans,
    fallback: [],
  })
}

/**
 * @function aggregate
 * @description Orchestrator AGGREGATE step (spec §7.4): merges the three
 *   PerspectiveReports into one final trade plan with consensus metrics,
 *   profit feasibility, and an optional no-trade reason. Output is sanitized
 *   (bounded numbers clamped 0-100, `side` validated against the enum).
 * @param {Object} params - Aggregate parameters.
 * @param {PerspectiveReport[]} params.reports - Perspective subagent reports.
 * @param {DDReport} params.ddReport - Due diligence report from the DD agent.
 * @param {number} params.targetProfitPercent - User's profit target.
 * @returns {Promise<PlanningAggregationResult | null>} Sanitized aggregation, or null on failure.
 */
export async function aggregate(params: {
  reports: PerspectiveReport[]
  ddReport: DDReport
  targetProfitPercent: number
}): Promise<PlanningAggregationResult | null> {
  return callPlanningLLM({
    phase: "aggregate",
    systemPrompt: AGGREGATE_PROMPT,
    userContent: JSON.stringify({
      reports: params.reports,
      ddReport: params.ddReport,
      targetProfitPercent: params.targetProfitPercent,
    }),
    parse: sanitizeAggregation,
    fallback: null,
  })
}
