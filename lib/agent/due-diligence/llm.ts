import OpenAI from "openai"
import { PLAN_PROMPT, REPLAN_PROMPT, AGGREGATE_PROMPT } from "@/lib/agent/due-diligence/prompts"
import { SubAgentThoughtSchema } from "@/lib/agent/due-diligence/subagent"
import type { SubAgentThought } from "@/lib/agent/due-diligence/subagent"
import { FACTOR_KEYS, type SubagentPlan, type FactorReport } from "@/lib/agent/due-diligence/types"

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"

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
 * @function think
 * @description LLM call for the subagent THINK step. Sends a message array (system prompt + context)
 *   and returns a parsed SubAgentThought (tool_call or return). Falls back to a safe default on failure.
 * @param {Array<{ role: string; content: string }>} messages - System prompt and context messages.
 * @returns {Promise<SubAgentThought>} Parsed SubAgentThought with action, tool params, or return values.
 */
export async function think(
  messages: Array<{ role: string; content: string }>
): Promise<SubAgentThought> {
  const c = getClient()
  if (!c) return { action: "return", score: 0, confidence: 0, signals: [], reasoning: "LLM unavailable", conclusion: "LLM client not configured" }

  const fallback = { action: "return" as const, score: 0, confidence: 0, signals: [], reasoning: "LLM call failed", conclusion: "THINK step failed after retry" }

  let content: string
  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      },
      { timeout: 30_000, maxRetries: 1 }
    )
    content = response.choices?.[0]?.message?.content || "{}"
  } catch (err) {
    console.error("[DD:think] API error:", err instanceof Error ? err.message : String(err))
    return fallback
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    console.error("[DD:think] JSON parse failed. Raw (first 500 chars):", content?.slice(0, 500))
    return fallback
  }

  try {
    return SubAgentThoughtSchema.parse(parsed)
  } catch (err) {
    console.error("[DD:think] Schema validation failed:", err)
    return fallback
  }
}

/**
 * @function plan
 * @description LLM call for the Main Agent's PLAN step. Given an asset and its category,
 *   determines which subagents to deploy and their instructions.
 * @param {Object} params - Plan parameters.
 * @param {string} params.asset - The asset ticker or identifier.
 * @param {{ name: string; activeFactors: string[] }} params.category - Category with name and active factors.
 * @returns {Promise<SubagentPlan[]>} Array of subagent plans with factor, instruction, and priority.
 */
export async function plan(params: {
  asset: string
  category: { name: string; activeFactors: string[] }
}): Promise<SubagentPlan[]> {
  const c = getClient()
  if (!c) return []

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PLAN_PROMPT },
          { role: "user", content: JSON.stringify({ asset: params.asset, category: params.category }) },
        ],
      },
      { timeout: 30_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "[]"
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error("[DD:plan] LLM call failed:", err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * @function rePlan
 * @description LLM call for the Main Agent's RE-DEPLOY step. Generates targeted instructions
 *   for low-confidence factors based on previous reports.
 * @param {Object} params - Re-plan parameters.
 * @param {string} params.asset - The asset ticker or identifier.
 * @param {string} params.category - The asset category.
 * @param {string[]} params.lowConfidenceFactors - Factor names that need re-analysis.
 * @param {FactorReport[]} params.previousReports - Previous factor reports for context.
 * @returns {Promise<SubagentPlan[]>} Array of re-deploy subagent plans.
 */
export async function rePlan(params: {
  asset: string
  category: string
  lowConfidenceFactors: string[]
  previousReports: FactorReport[]
}): Promise<SubagentPlan[]> {
  const c = getClient()
  if (!c) return []

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REPLAN_PROMPT },
          { role: "user", content: JSON.stringify(params) },
        ],
      },
      { timeout: 30_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "[]"
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error("[DD:rePlan] LLM call failed:", err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * @function aggregate
 * @description LLM call for the Main Agent's AGGREGATE step. Merges FactorReports into a
 *   consolidated thesis with cross-validation, risks, catalysts, and summary.
 * @param {Object} params - Aggregate parameters.
 * @param {string} params.asset - The asset ticker or identifier.
 * @param {string} params.category - The asset category.
 * @param {FactorReport[]} params.factorReports - Array of reports from subagent runs.
 * @returns {Promise<{ thesis: string; crossValidation: { pairs: Array<{ factorA: string; factorB: string; alignment: number; note: string }>; overallAlignment: number; contradictions: string[] }; risks: Array<{ factor: string; description: string; severity: string }>; catalysts: Array<{ factor: string; description: string; impact: string }>; summary: string }>}
 *   The aggregated thesis, cross-validation data, risks, catalysts, and summary.
 */
export async function aggregate(params: {
  asset: string
  category: string
  factorReports: FactorReport[]
}): Promise<{
  thesis: string
  crossValidation: {
    pairs: Array<{ factorA: string; factorB: string; alignment: number; note: string }>
    overallAlignment: number
    contradictions: string[]
  }
  risks: Array<{ factor: string; description: string; severity: string }>
  catalysts: Array<{ factor: string; description: string; impact: string }>
  summary: string
}> {
  const c = getClient()
  if (!c) {
    return {
      thesis: "LLM unavailable",
      crossValidation: { pairs: [], overallAlignment: 0, contradictions: [] },
      risks: [],
      catalysts: [],
      summary: "LLM client not configured",
    }
  }

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AGGREGATE_PROMPT },
          { role: "user", content: JSON.stringify(params) },
        ],
      },
      { timeout: 30_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "{}"
    const parsed = JSON.parse(content)

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Aggregate response is not an object")
    }

    const validFactors = new Set<string>(FACTOR_KEYS)

    if (Array.isArray(parsed.risks)) {
      parsed.risks = parsed.risks.filter(
        (r: { factor?: unknown }) => r && typeof r.factor === "string" && validFactors.has(r.factor)
      )
    }

    if (Array.isArray(parsed.catalysts)) {
      parsed.catalysts = parsed.catalysts.filter(
        (c: { factor?: unknown }) => c && typeof c.factor === "string" && validFactors.has(c.factor)
      )
    }

    if (parsed.crossValidation && Array.isArray(parsed.crossValidation.pairs)) {
      parsed.crossValidation.pairs = parsed.crossValidation.pairs.filter(
        (p: { factorA?: unknown; factorB?: unknown }) =>
          p &&
          typeof p.factorA === "string" && validFactors.has(p.factorA) &&
          typeof p.factorB === "string" && validFactors.has(p.factorB)
      )
    }

    return parsed as any
  } catch (err) {
    console.error("[DD:aggregate] LLM call failed:", err instanceof Error ? err.message : String(err))
    return {
      thesis: "Aggregation failed",
      crossValidation: { pairs: [], overallAlignment: 0, contradictions: [] },
      risks: [],
      catalysts: [],
      summary: "Aggregation step failed after retry",
    }
  }
}
