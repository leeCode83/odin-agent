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
import { AggregationResultSchema, type SubagentPlan, type FactorReport } from "@/lib/agent/due-diligence/types"
import { parsePlanOutput } from "@/lib/agent/due-diligence/plan-validator"
import { createDdLogger } from "@/lib/agent/due-diligence/logger"
import { parseLlmJson, parseInvokeXml } from "@/lib/agent/shared/json-utils"
import { normalizeThought, formatZodErrors } from "@/lib/agent/shared/llm-helpers"
import { getClient, DEEPSEEK_MODEL, DEEPSEEK_THINK_MODEL } from "@/lib/agent/shared/llm-client"
export { normalizeThought, formatZodErrors }
import { z } from "zod"

const log = createDdLogger({ module: "llm" })

/**
 * @function sleep
 * @description Resolves after `ms` milliseconds — used for exponential backoff
 *   between empty-response retries in think().
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves once the delay elapses.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))


/**
 * @function think
 * @description LLM call for the subagent THINK step. Sends a message array (system prompt + context)
 *   and returns a ThinkResult: a parsed SubAgentThought (tool_call or return), or the raw native
 *   tool_calls when `options.tools` was provided and the model answered with tool_calls.
 *   Falls back to a safe default on failure. Empty or missing responses are retried
 *   with exponential backoff (1s then 2s, 3 calls total) before falling back; API
 *   throws are not retried here (the SDK maxRetries handles transient network errors).
 *   On JSON parse failure, retries once with the parse
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
  if (!c) return { action: "return", score: null, confidence: null, signals: [], reasoning: "LLM unavailable", conclusion: "LLM client not configured" }

  // reason: the user message always carries {"factor": "...", ...} — extract it
  // so failure logs identify which subagent the LLM call belonged to.
  const userMsg = messages.find((m) => m.role === "user")
  let factor = "unknown"
  try {
    const parsed = userMsg?.content ? JSON.parse(userMsg.content) : null
    if (parsed && typeof parsed.factor === "string") factor = parsed.factor
  } catch { /* non-JSON user message — keep "unknown" */ }

  // reason: score/confidence must be null, not 0 — a fake 0 looks like a valid
  // bearish analysis and pollutes overallScore/overallConfidence downstream
  // (evaluate.ts filters on score !== null to count usable factors).
  const fallback = { action: "return" as const, score: null, confidence: null, signals: [], reasoning: "LLM call failed", conclusion: "THINK step failed after retry" }

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

  // reason: DeepSeek reasoning models drift into Claude-style XML tool calls
  // (<invoke name="...">) instead of JSON — embrace it: convert the blocks to
  // native tool_calls so the ReAct loop executes them, cheaper than an LLM
  // retry that would likely repeat the same drift. Shared by the first-shot
  // and retry parse-fail paths.
  const xmlToNativeResult = (xmlContent: string, retry: boolean): NativeToolCallsResult | null => {
    const xmlCalls = parseInvokeXml(xmlContent)
    if (xmlCalls === null) return null
    log("info", "think_xml_tool_calls", { factor, count: xmlCalls.length, retry })
    return toNativeResult({
      role: "assistant",
      content: xmlContent,
      tool_calls: xmlCalls.map((c, i) => ({
        id: `call_xml_${i}`,
        type: "function" as const,
        function: { name: c.toolName, arguments: JSON.stringify(c.params) },
      })),
    })
  }

  // reason: the model intermittently returns an empty content string or no
  // message at all (rate limits, overloaded reasoning model) — retry with
  // exponential backoff up to 3 total calls before falling back. API throws
  // are NOT retried here: the SDK's maxRetries already covers transient
  // network errors, and a throw usually means a hard config failure worth
  // surfacing immediately.
  const callLLM = async (
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = requestMessages
  ): Promise<OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam | null> => {
    // reason: attempt is 1-based so the backoff formula `500ms * 2^attempt`
    // yields 1s then 2s — a 0-based attempt would make the first sleep 500ms.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await c.chat.completions.create(
          {
            model: DEEPSEEK_THINK_MODEL,
            temperature: 0.3,
            max_tokens: 8192,
            response_format: { type: "json_object" },
            ...(options?.tools ? { tools: options.tools } : {}),
            messages: msgs,
          },
          { timeout: 45_000, maxRetries: 1 }
        )
        const message = response.choices?.[0]?.message
        if (
          message &&
          ((typeof message.content === "string" && message.content.trim().length > 0) ||
            (message.tool_calls?.length ?? 0) > 0)
        ) {
          return message as unknown as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
        }
        log("error", "think_empty_response_retry", {
          factor,
          attempt,
          reason: message ? "empty_content" : "missing_message",
        })
        if (attempt < 3) {
          await sleep(500 * 2 ** attempt)
        }
      } catch (err) {
        log("error", "think_api_error", { factor, error: err instanceof Error ? err.message : String(err) })
        return null
      }
    }
    log("error", "think_empty_response", { factor, model: DEEPSEEK_THINK_MODEL, reason: "empty after 3 attempts" })
    return null
  }

  const message = await callLLM()
  if (message === null) return fallback

  if (options?.tools && message.tool_calls && message.tool_calls.length > 0) {
    return toNativeResult(message)
  }

  // reason: the SDK types assistant content as string | content-part array — only the
  // string form is JSON-parsable; the empty-string case is already exhausted
  // inside callLLM's retry loop (message only returns with non-empty content or tool_calls).
  let content = typeof message.content === "string" ? message.content : ""

  let parsed: unknown
  parsed = parseLlmJson(content)
  if (parsed === null) {
    const xmlResult = xmlToNativeResult(content, false)
    if (xmlResult !== null) return xmlResult
    // reason: DeepSeek reasoning models emit valid JSON followed by trailing
    // prose — parseLlmJson already strips fences and extracts the first
    // balanced object; only truly unparseable output reaches this retry.
    log("error", "think_json_parse_failed", { factor, rawPrefix: content.slice(0, 300) })
    // reason: a blind re-call replays the same failure — feed the parse error and the
    // truncated raw output back so the model can correct the malformed JSON.
    const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was not valid JSON.

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
    parsed = parseLlmJson(content)
    if (parsed === null) {
      // reason: the retry can drift into XML tool calls too — same embrace as
      // the first-shot path, executed instead of the final fallback.
      const retryXmlResult = xmlToNativeResult(content, true)
      if (retryXmlResult !== null) return retryXmlResult
      log("error", "think_json_repair_failed", { factor, rawPrefix: content.slice(0, 300) })
      return fallback
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed as Record<string, unknown>).length === 0) {
    log("error", "think_empty_object", { factor })
    return fallback
  }

  const MAX_SCHEMA_CORRECTIONS = 2
  // reason: explicit unknown — control-flow narrowing of `parsed` (falsy after
  // the empty-object guard) would otherwise widen this to `{} | undefined`.
  let currentParsed: unknown = parsed
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

      currentParsed = parseLlmJson(currentContent)
      if (currentParsed === null) {
        log("error", "think_json_repair_failed_in_correction", { factor, rawPrefix: currentContent.slice(0, 300) })
        return fallback
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
 * @description LLM call for the Main Agent's PLAN step. Given an asset,
 *   determines which subagents to deploy and their instructions.
 *   Output is sanitized via parsePlanOutput (filters invalid factors,
 *   forces technical + onchain presence).
 * @param {Object} params - Plan parameters.
 * @param {string} params.asset - The asset ticker or identifier.
 * @returns {Promise<SubagentPlan[]>} Array of subagent plans with factor, instruction, and priority.
 */
export async function plan(params: {
  asset: string
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
          { role: "user", content: JSON.stringify({ asset: params.asset }) },
        ],
      },
      { timeout: 45_000, maxRetries: 1 }
    )
    const content = response.choices?.[0]?.message?.content || "[]"
    return parsePlanOutput(content, "plan")
  } catch (err) {
    log("error", "plan_api_error", { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/**
 * @function rePlan
 * @description LLM call for the Main Agent's RE-DEPLOY step. Generates targeted instructions
 *   for low-confidence factors based on previous reports.
 *   Output is sanitized via parsePlanOutput (filters invalid factors,
 *   forces technical + onchain presence).
 * @param {Object} params - Re-plan parameters.
 * @param {string} params.asset - The asset ticker or identifier.
 * @param {string[]} params.lowConfidenceFactors - Factor names that need re-analysis.
 * @param {FactorReport[]} params.previousReports - Previous factor reports for context.
 * @returns {Promise<SubagentPlan[]>} Array of re-deploy subagent plans.
 */
export async function rePlan(params: {
  asset: string
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
    return parsePlanOutput(content, "replan")
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

export async function aggregate(params: {
  asset: string
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

    const parsed: unknown = parseLlmJson(content)
    if (parsed === null) {
      log("error", "aggregate_json_parse_failed", { rawLength: content.length, rawPrefix: content.slice(0, 300) })
      if (attempts >= 3) {
        log("error", "aggregate_json_repair_failed", {})
        return null
      } else {
        const retryContent = `${requestMessages.find((m) => m.role === "user")?.content ?? ""}

Your previous response was not valid JSON.

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
