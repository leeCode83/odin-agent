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
 * @function normalizeThought
 * @description Salvages common LLM output drift before strict schema parsing.
 *   The discriminated union only accepts exactly "tool_call" | "return" —
 *   LLMs drift on this field (null, "", "conclude", "EXTRACT", ...) and any
 *   unrecognized value would discard a valid analysis into the score-0
 *   fallback. Only a tool_call alias survives as "tool_call"; EVERYTHING else
 *   becomes "return" so the subagent yields a usable report. Also defaults a
 *   missing `conclusion` string on return thoughts to "".
 * @param {unknown} raw - The parsed (but unvalidated) LLM output.
 * @returns {unknown} The normalized output, ready for SubAgentThoughtSchema.
 */
function normalizeThought(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw
  const p = raw as Record<string, unknown>
  const action = typeof p.action === "string" ? p.action.toLowerCase() : ""
  if (action === "tool_call" || ["call_tool", "use_tool", "execute_tool", "tool"].includes(action)) {
    p.action = "tool_call"
  } else {
    // reason: unknown/null/missing action cannot be a tool call — defaulting
    // to "return" keeps the analysis instead of failing into the fallback.
    p.action = "return"
  }
  // reason: LLMs frequently omit "conclusion" on return thoughts; the schema
  // requires a string, so default it rather than discarding the whole thought.
  if (p.action === "return") {
    if (typeof p.conclusion !== "string") p.conclusion = ""
    if (typeof p.score !== "number") p.score = 0
    if (typeof p.confidence !== "number") p.confidence = 0
    if (!Array.isArray(p.signals)) p.signals = []
    if (typeof p.reasoning !== "string") p.reasoning = "No reasoning provided — LLM returned incomplete response"
  }
  return raw
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

  // reason: the user message always carries {"factor": "...", ...} — extract it
  // so failure logs identify which subagent the LLM call belonged to.
  const userMsg = messages.find((m) => m.role === "user")
  let factor = "unknown"
  try {
    const parsed = userMsg ? JSON.parse(userMsg.content) : null
    if (parsed && typeof parsed.factor === "string") factor = parsed.factor
  } catch { /* non-JSON user message — keep "unknown" */ }

  const fallback = { action: "return" as const, score: 0, confidence: 0, signals: [], reasoning: "LLM call failed", conclusion: "THINK step failed after retry" }

  const callLLM = async (): Promise<string | null> => {
    try {
      const response = await c.chat.completions.create(
        {
          model: DEEPSEEK_MODEL,
          temperature: 0.3,
          max_tokens: 4096,
          response_format: { type: "json_object" },
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        },
        { timeout: 45_000, maxRetries: 1 }
      )
      const content = response.choices?.[0]?.message?.content || ""
      if (!content.trim()) {
        console.error("[DD:think] Empty LLM response. factor=%s model=%s. Check API key, rate limits.", factor, DEEPSEEK_MODEL)
        return null
      }
      return content
    } catch (err) {
      console.error("[DD:think] API error. factor=%s:", factor, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  let content = await callLLM()
  if (content === null) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    console.error("[DD:think] JSON parse failed. factor=%s. Raw (first 500 chars):", factor, content?.slice(0, 500))
    // Truncated responses are usually transient — retry once before falling back.
    await new Promise((r) => setTimeout(r, 500))
    content = await callLLM()
    if (content === null) return fallback
    try {
      parsed = JSON.parse(content)
    } catch {
      // Retry failed too — salvage truncated JSON (unterminated string / unclosed braces).
      const repaired = repairJSON(content)
      if (!repaired) {
        console.error("[DD:think] JSON repair failed. factor=%s", factor)
        return fallback
      }
      parsed = repaired
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed as Record<string, unknown>).length === 0) {
    console.error("[DD:think] LLM returned empty object {}. factor=%s — treating as failed response.", factor)
    return fallback
  }

  try {
    return SubAgentThoughtSchema.parse(normalizeThought(parsed))
  } catch (err) {
    console.error("[DD:think] Schema validation failed. factor=%s:", factor, err)
    console.error("[DD:think] Raw LLM output (first 300 chars):", content?.slice(0, 300))
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
        max_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PLAN_PROMPT },
          { role: "user", content: JSON.stringify({ asset: params.asset, category: params.category }) },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
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
        max_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REPLAN_PROMPT },
          { role: "user", content: JSON.stringify(params) },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
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
interface AggregateResult {
  thesis: string
  crossValidation: {
    pairs: Array<{ factorA: string; factorB: string; alignment: number; note: string }>
    overallAlignment: number
    contradictions: string[]
  }
  risks: Array<{ factor: string; description: string; severity: string }>
  catalysts: Array<{ factor: string; description: string; impact: string }>
  summary: string
}

/**
 * @function repairJSON
 * @description Attempts to salvage truncated JSON by closing unclosed braces and brackets.
 *   Falls back to null if the input is irreparable.
 * @param {string} raw - The potentially truncated JSON string.
 * @returns {object | null} Repaired parsed object, or null if beyond repair.
 */
function repairJSON(raw: string): object | null {
  try { return JSON.parse(raw) } catch { /* parse failed, attempt repair */ }

  let fixed = raw
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]")
    } else if (ch === "}" || ch === "]") {
      stack.pop()
    }
  }
  // Unterminated string (truncated mid-value) — close it before closing structure.
  if (inString) fixed += '"'
  // Close any unclosed braces/brackets in reverse order
  while (stack.length > 0) fixed += stack.pop()

  try { return JSON.parse(fixed) } catch { /* repair failed */ }
  return null
}

export async function aggregate(params: {
  asset: string
  category: string
  factorReports: FactorReport[]
}): Promise<AggregateResult | null> {
  const c = getClient()
  if (!c) return null

  let content: string
  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AGGREGATE_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              asset: params.asset,
              category: params.category,
              factorReports: params.factorReports.map((fr) => {
                // Strip reasoning — aggregate only needs structured data
                const { reasoning: _reasoning, ...rest } = fr
                void _reasoning
                return rest
              }),
            }),
          },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
    )
    content = response.choices?.[0]?.message?.content || "{}"
  } catch (err) {
    console.error("[DD:aggregate] API error:", err instanceof Error ? err.message : String(err))
    return null
  }

  // Try strict parse first, then JSON repair for truncated output
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    console.error("[DD:aggregate] JSON parse failed, attempting repair. Raw length:", content.length)
    const repaired = repairJSON(content)
    if (!repaired) {
      console.error("[DD:aggregate] JSON repair also failed")
      return null
    }
    parsed = repaired
  }

  if (typeof parsed !== "object" || parsed === null) return null

  const validFactors = new Set<string>(FACTOR_KEYS)

  if (Array.isArray((parsed as Record<string, unknown>).risks)) {
    (parsed as Record<string, unknown>).risks = (
      (parsed as Record<string, unknown>).risks as Array<{ factor?: unknown }>
    ).filter((r) => r && typeof r.factor === "string" && validFactors.has(r.factor))
  }

  if (Array.isArray((parsed as Record<string, unknown>).catalysts)) {
    (parsed as Record<string, unknown>).catalysts = (
      (parsed as Record<string, unknown>).catalysts as Array<{ factor?: unknown }>
    ).filter((c) => c && typeof c.factor === "string" && validFactors.has(c.factor))
  }

  const cv = (parsed as Record<string, unknown>).crossValidation as Record<string, unknown> | undefined
  if (cv && Array.isArray(cv.pairs)) {
    cv.pairs = (cv.pairs as Array<{ factorA?: unknown; factorB?: unknown }>).filter(
      (p) =>
        p &&
        typeof p.factorA === "string" && validFactors.has(p.factorA) &&
        typeof p.factorB === "string" && validFactors.has(p.factorB)
    )
  }

  return parsed as AggregateResult
}
