/**
 * @file due-diligence/llm.ts
 * @description DeepSeek-backed LLM calls for the due-diligence agent: THINK, PLAN, RE-PLAN, and AGGREGATE steps.
 * @module due-diligence
 * @layer service
 */

import OpenAI from "openai"
import { getPrompt } from "@/lib/agent/due-diligence/prompt-registry"
import "@/lib/agent/due-diligence/prompts"
import { SubAgentThoughtSchema } from "@/lib/agent/due-diligence/subagent"
import type { LlmThinkMessage, ThinkOptions, ThinkResult, NativeToolCallsResult } from "@/lib/agent/due-diligence/subagent"
import { SubagentPlanSchema, AggregationResultSchema, type SubagentPlan, type FactorReport } from "@/lib/agent/due-diligence/types"
import { createDdLogger } from "@/lib/agent/due-diligence/logger"
import { z } from "zod"

const log = createDdLogger({ module: "llm" })

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
export function normalizeThought(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw
  const p = raw as Record<string, unknown>
  const action = typeof p.action === "string" ? p.action.toLowerCase() : ""
  if (action === "tool_call" || ["call_tool", "use_tool", "execute_tool", "tool"].includes(action)) {
    p.action = "tool_call"
    if (typeof p.reasoning !== "string") p.reasoning = ""
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
 * @function formatZodErrors
 * @description Converts an array of Zod issues into a human-readable string for the LLM.
 * @param {z.ZodIssue[]} issues - The array of validation issues from Zod.
 * @returns {string} The formatted error string.
 * @example
 * formatZodErrors(issues) // "Your previous response had 1 validation error:\n1. Field "reasoning" Required. ..."
 */
export function formatZodErrors(issues: z.ZodIssue[]): string {
  if (!issues || issues.length === 0) return ""
  
  const count = issues.length
  const header = `Your previous response had ${count} validation error${count > 1 ? 's' : ''}:`
  
  const formatted = issues.map((issue, index) => {
    const path = issue.path.reduce<string>((acc, part) => {
      if (typeof part === 'number') {
        return `${acc}[${part}]`
      }
      return acc ? `${acc}.${String(part)}` : String(part)
    }, "")
    
    return `${index + 1}. Field "${path}" ${issue.message}.`
  })
  
  return `${header}\n${formatted.join('\n')}\nPlease return corrected JSON only.`
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
    m.role === "user" ? { ...m, content: `${m.content ?? ""}\n\n${getPrompt("DD_THINK_JSON_INSTRUCTION")}` } : { ...m }
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
        log("error", "think_empty_response", { factor, model: DEEPSEEK_THINK_MODEL, reason: "Check API key, rate limits" })
        return null
      }
      return message as unknown as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    } catch (err) {
      log("error", "think_api_error", { factor, error: err instanceof Error ? err.message : String(err) })
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
    log("error", "think_empty_response", { factor, model: DEEPSEEK_THINK_MODEL, reason: "Check API key, rate limits" })
    return fallback
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    log("error", "think_json_parse_failed", { factor, error: err instanceof Error ? err.message : String(err) })
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
        log("error", "think_json_repair_failed", { factor })
        return fallback
      }
      parsed = repaired
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed as Record<string, unknown>).length === 0) {
    log("error", "think_empty_object", { factor })
    return fallback
  }

  const MAX_SCHEMA_CORRECTIONS = 2
  let currentParsed = parsed
  let currentContent = content

  for (let attempt = 0; attempt <= MAX_SCHEMA_CORRECTIONS; attempt++) {
    try {
      const result = SubAgentThoughtSchema.parse(normalizeThought(currentParsed))
      if (attempt > 0) {
        log("info", "think_schema_corrected", { factor, attempt })
      }
      return result
    } catch (err) {
      if (attempt === MAX_SCHEMA_CORRECTIONS) {
        log("error", "think_schema_correction_failed", { factor, attempts: MAX_SCHEMA_CORRECTIONS, error: err instanceof Error ? err.message : String(err), rawOutputPrefix: currentContent?.slice(0, 300) })
        return fallback
      }

      let zodIssues: z.ZodIssue[] = []
      if (err instanceof z.ZodError) {
        zodIssues = err.issues
      }

      const errorFeedback = formatZodErrors(zodIssues)
      const correctionMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...requestMessages,
        { role: "assistant", content: currentContent },
        { role: "user", content: errorFeedback || "Your previous response failed schema validation. Please return corrected JSON only." }
      ]

      const retryMessage = await callLLM(correctionMessages)
      if (retryMessage === null) return fallback

      if (options?.tools && retryMessage.tool_calls && retryMessage.tool_calls.length > 0) {
        log("info", "think_schema_corrected", { factor, attempt: attempt + 1, type: "native_tool_call" })
        return toNativeResult(retryMessage)
      }

      currentContent = typeof retryMessage.content === "string" ? retryMessage.content : ""
      if (!currentContent.trim()) return fallback

      try {
        currentParsed = JSON.parse(currentContent)
      } catch {
        const repaired = repairJSON(currentContent)
        if (!repaired) {
          log("error", "think_json_repair_failed_in_correction", { factor })
          return fallback
        }
        currentParsed = repaired
      }

      if (currentParsed && typeof currentParsed === "object" && !Array.isArray(currentParsed) && Object.keys(currentParsed as Record<string, unknown>).length === 0) {
        return fallback
      }
    }
  }

  return fallback
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
          { role: "system", content: getPrompt("DD_PLAN") },
          { role: "user", content: JSON.stringify({ asset: params.asset, category: params.category }) },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "[]"
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    
    const validPlans: SubagentPlan[] = []
    for (const item of parsed) {
      const result = SubagentPlanSchema.safeParse(item)
      if (result.success) {
        validPlans.push(result.data)
      } else {
        log("warn", "plan_invalid_item_dropped", { factor: item?.factor, error: result.error.message })
      }
    }
    return validPlans
  } catch (err) {
    log("error", "plan_api_error", { error: err instanceof Error ? err.message : String(err) })
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
          { role: "system", content: getPrompt("DD_REPLAN") },
          { role: "user", content: JSON.stringify(params) },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "[]"
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []

    const validPlans: SubagentPlan[] = []
    for (const item of parsed) {
      const result = SubagentPlanSchema.safeParse(item)
      if (result.success) {
        validPlans.push(result.data)
      } else {
        log("warn", "replan_invalid_item_dropped", { factor: item?.factor, error: result.error.message })
      }
    }
    return validPlans
  } catch (err) {
    log("error", "replan_api_error", { error: err instanceof Error ? err.message : String(err) })
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
    { role: "system", content: getPrompt("DD_AGGREGATE") },
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
      log("error", "aggregate_api_error", { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  let currentMessages = requestMessages
  let attempts = 0

  while (attempts < 3) {
    attempts++
    const content = await callLLM(currentMessages)
    if (content === null) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      log("error", "aggregate_json_parse_failed", { rawLength: content.length, error: err instanceof Error ? err.message : String(err) })
      if (attempts >= 3) {
        const repaired = repairJSON(content)
        if (!repaired) {
          log("error", "aggregate_json_repair_failed", {})
          return null
        }
        parsed = repaired
      } else {
        const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was not valid JSON.
error: "Invalid JSON: ${err instanceof Error ? err.message : String(err)}"

rawPrefix: ${content.slice(0, 500)}`
        currentMessages = [
          ...requestMessages,
          { role: "user", content: retryContent },
        ]
        continue
      }
    }

    if (!parsed || typeof parsed !== "object") {
      if (attempts >= 3) return null
      currentMessages = [
        ...requestMessages,
        { role: "user", content: "Your previous response was not a JSON object." },
      ]
      continue
    }

    const result = AggregationResultSchema.safeParse(parsed)
    if (result.success) {
      if (attempts > 1) {
        log("info", "aggregate_schema_corrected", { attempt: attempts })
      }
      return result.data
    }

    if (attempts >= 3) {
      log("error", "aggregate_schema_correction_failed", {
        attempts,
        error: formatZodErrors(result.error.issues),
        rawOutputPrefix: content.slice(0, 500)
      })
      return null
    }

    const issuesMsg = formatZodErrors(result.error.issues)
    const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was invalid against the required schema. Fix these issues:
${issuesMsg}`

    currentMessages = [
      ...requestMessages,
      { role: "user", content: retryContent },
    ]
  }

  return null
}
