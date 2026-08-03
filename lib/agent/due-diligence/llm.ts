/**
 * @file due-diligence/llm.ts
 * @description DeepSeek-backed LLM calls for the due-diligence agent: THINK, PLAN, RE-PLAN, and AGGREGATE steps.
 * @module due-diligence
 * @layer service
 */

import OpenAI from "openai"
import { PLAN_PROMPT, REPLAN_PROMPT, AGGREGATE_PROMPT, THINK_JSON_INSTRUCTION } from "@/lib/agent/due-diligence/prompts"
import { SubAgentThoughtSchema } from "@/lib/agent/due-diligence/subagent"
import type { LlmThinkMessage, ThinkOptions, ThinkResult, NativeToolCallsResult } from "@/lib/agent/due-diligence/subagent"
import { FACTOR_KEYS, type SubagentPlan, type FactorReport } from "@/lib/agent/due-diligence/types"

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
const DEEPSEEK_THINK_MODEL = process.env.DEEPSEEK_THINK_MODEL || "deepseek-v4-pro"

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
 *   and returns a ThinkResult: a parsed SubAgentThought (tool_call or return), or the raw native
 *   tool_calls when `options.tools` was provided and the model answered with tool_calls.
 *   Falls back to a safe default on failure. On JSON parse failure, retries once with the parse
 *   error fed back to the model, then repairJSON, then fallback.
 *   json_schema not supported by DeepSeek — using json_object + schema prompt.
 * @param {Array<LlmThinkMessage>} messages - System prompt and context messages (may include
 *   native `tool` role messages from a previous loop iteration).
 * @param {ThinkOptions} [options] - Optional request options; `tools` enables native function calling.
 * @returns {Promise<ThinkResult>} Native tool_calls, or a parsed SubAgentThought, or a fallback return thought.
 */
export async function think(
  messages: Array<LlmThinkMessage>,
  options?: ThinkOptions
): Promise<ThinkResult> {
  const c = getClient()
  if (!c) return { action: "return", score: 0, confidence: 0, signals: [], reasoning: "LLM unavailable", conclusion: "LLM client not configured" }

  // reason: the user message always carries {"factor": "...", ...} — extract it
  // so failure logs identify which subagent the LLM call belonged to.
  const userMsg = messages.find((m) => m.role === "user")
  let factor = "unknown"
  try {
    const parsed = userMsg?.content ? JSON.parse(userMsg.content) : null
    if (parsed && typeof parsed.factor === "string") factor = parsed.factor
  } catch { /* non-JSON user message — keep "unknown" */ }

  const fallback = { action: "return" as const, score: 0, confidence: 0, signals: [], reasoning: "LLM call failed", conclusion: "THINK step failed after retry" }

  // reason: DeepSeek json_object mode only guarantees valid JSON when the prompt
  // explicitly demands it — append the instruction to the user message (new array,
  // caller's messages are never mutated; factor extraction above reads the originals).
  const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map((m) =>
    m.role === "user" ? { ...m, content: `${m.content ?? ""}\n\n${THINK_JSON_INSTRUCTION}` } : { ...m }
  ) as OpenAI.Chat.Completions.ChatCompletionMessageParam[]

  // reason: native tool_calls are returned raw so the ReAct loop can execute them
  // and feed back {role:"tool"} messages; the assistant message is echoed alongside.
  const toNativeResult = (msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam): NativeToolCallsResult => ({
    action: "native_tool_call",
    toolCalls: (msg.tool_calls ?? []).map((tc) => {
      // reason: the SDK unions custom tool calls into the same array — only the
      // function variant carries name/arguments; default to "{}" for anything else.
      const fn = (tc as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall).function
      return {
        id: tc.id,
        toolName: fn?.name ?? "",
        rawArguments: fn?.arguments ?? "{}",
      }
    }),
    assistantMessage: msg,
  })

  const callLLM = async (
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = requestMessages
  ): Promise<OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam | null> => {
    try {
      const response = await c.chat.completions.create(
        {
          model: DEEPSEEK_THINK_MODEL,
          temperature: 0.3,
          max_tokens: 4096,
          response_format: { type: "json_object" },
          ...(options?.tools ? { tools: options.tools } : {}),
          messages: msgs,
        },
        { timeout: 45_000, maxRetries: 1 }
      )
      const message = response.choices?.[0]?.message
      if (!message) {
        console.error("[DD:think] Empty LLM response. factor=%s model=%s. Check API key, rate limits.", factor, DEEPSEEK_THINK_MODEL)
        return null
      }
      return message as unknown as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    } catch (err) {
      console.error("[DD:think] API error. factor=%s:", factor, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const message = await callLLM()
  if (message === null) return fallback

  if (options?.tools && message.tool_calls && message.tool_calls.length > 0) {
    return toNativeResult(message)
  }

  // reason: the SDK types assistant content as string | content-part array — only the
  // string form is JSON-parsable; any array form falls through to the empty response path.
  let content = typeof message.content === "string" ? message.content : ""
  if (!content.trim()) {
    console.error("[DD:think] Empty LLM response. factor=%s model=%s. Check API key, rate limits.", factor, DEEPSEEK_THINK_MODEL)
    return fallback
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    console.error("[DD:think] JSON parse failed — retrying with error feedback. factor=%s", factor)
    // reason: a blind re-call replays the same failure — feed the parse error and the
    // truncated raw output back so the model can correct the malformed JSON.
    const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was not valid JSON.
error: "Invalid JSON: ${err instanceof Error ? err.message : String(err)}"

rawPrefix: ${content.slice(0, 500)}`
    const retryMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...requestMessages,
      { role: "user", content: retryContent },
    ]
    const retryMessage = await callLLM(retryMessages)
    if (retryMessage === null) return fallback
    // reason: the model may answer the retry with native tool_calls — honor them
    // instead of discarding a valid turn into the JSON fallback.
    if (options?.tools && retryMessage.tool_calls && retryMessage.tool_calls.length > 0) {
      return toNativeResult(retryMessage)
    }
    content = typeof retryMessage.content === "string" ? retryMessage.content : ""
    try {
      parsed = JSON.parse(content)
    } catch {
      // reason: retry failed too — salvage truncated JSON (unterminated string / unclosed braces).
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
 *   On JSON parse failure, retries once with the parse error fed back to the model, then repairJSON, then null.
 *   json_schema not supported by DeepSeek — using json_object + schema prompt.
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

  const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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
  ]

  const callLLM = async (msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = requestMessages): Promise<string | null> => {
    try {
      const response = await c.chat.completions.create(
        {
          model: DEEPSEEK_MODEL,
          temperature: 0.3,
          max_tokens: 8192,
          response_format: { type: "json_object" },
          messages: msgs,
        },
        { timeout: 45_000, maxRetries: 1 }
      )
      return response.choices?.[0]?.message?.content || "{}"
    } catch (err) {
      console.error("[DD:aggregate] API error:", err instanceof Error ? err.message : String(err))
      return null
    }
  }

  let content = await callLLM()
  if (content === null) return null

  // Try strict parse first, then error-feedback retry, then JSON repair for truncated output
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    console.error("[DD:aggregate] JSON parse failed — retrying with error feedback. Raw length:", content.length)
    const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was not valid JSON.
error: "Invalid JSON: ${err instanceof Error ? err.message : String(err)}"

rawPrefix: ${content.slice(0, 500)}`
    const retryMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...requestMessages,
      { role: "user", content: retryContent },
    ]
    content = await callLLM(retryMessages)
    if (content === null) return null
    try {
      parsed = JSON.parse(content)
    } catch {
      // reason: retry failed too — salvage truncated JSON (unterminated string / unclosed braces).
      const repaired = repairJSON(content)
      if (!repaired) {
        console.error("[DD:aggregate] JSON repair also failed")
        return null
      }
      parsed = repaired
    }
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
