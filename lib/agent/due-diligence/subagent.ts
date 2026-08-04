/**
 * @file due-diligence/subagent.ts
 * @description Generic ReAct loop (THINK → ACT → OBSERVE → REFLECT) for factor subagents.
 *   Each subagent receives tools, an instruction, and an asset, then loops until
 *   the LLM returns a final judgment or the iteration/timeout budget is exhausted.
 * @module due-diligence
 * @layer service
 */

import { z } from "zod"
import type OpenAI from "openai"
import type { FactorReport, SignalEntry } from "@/lib/agent/due-diligence/types"
import type { ToolRegistry } from "@/lib/agent/tools/types"
import { toolRegistryToOpenAITools } from "@/lib/agent/tools/types"

/**
 * @constant SignalEntrySchema
 * @description Accepts a SignalEntry object or a plain signal string (e.g. "RSI oversold").
 *   String is normalized to { name, strength: 50, direction: "neutral" } in runSubagent.
 */
const SignalEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    strength: z.number().int().min(0).max(100),
    direction: z.enum(["bullish", "bearish", "neutral"]),
  }),
])

/**
 * @function normalizeSignal
 * @description Converts a raw parsed signal (string or object) to a SignalEntry.
 */
function normalizeSignal(signal: string | { name?: string; strength?: number; direction?: "bullish" | "bearish" | "neutral" }): SignalEntry {
  if (typeof signal === "string") {
    return { name: signal, strength: 50, direction: "neutral" }
  }
  return {
    name: signal.name ?? "unknown",
    strength: signal.strength ?? 50,
    direction: signal.direction ?? "neutral",
  }
}

/**
 * @constant SubAgentThoughtSchema
 * @description Zod discriminated union for the LLM's THINK output.
 *   - `tool_call`: the LLM wants to invoke a tool.
 *   - `return`: the LLM has reached a conclusion and returns.
 *   signals accepts both string[] and SignalEntry[] for resilience against LLM format drift.
 */
export const SubAgentThoughtSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tool_call"),
    toolName: z.string(),
    params: z.record(z.string(), z.unknown()),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal("return"),
    score: z.number().int().min(0).max(100).nullable(),
    confidence: z.number().int().min(0).max(100).nullable(),
    signals: z.array(SignalEntrySchema),
    reasoning: z.string(),
    conclusion: z.string(),
    // reason: optional planning swarm fields — zod strips unknown keys, so the
    // planning wrapper can only receive these from the LLM if the schema declares them.
    side: z.enum(["long", "short", "no_trade"]).optional(),
    entry_price: z.number().optional(),
    suggested_stop_loss: z.number().optional(),
    suggested_take_profit: z.number().optional(),
    suggested_leverage: z.number().optional(),
    suggested_position_size_usdc: z.number().optional(),
    risk_flags: z.array(z.string()).optional(),
  }),
])

/** @typedef {z.infer<typeof SubAgentThoughtSchema>} SubAgentThought */
export type SubAgentThought = z.infer<typeof SubAgentThoughtSchema>

/**
 * @typedef LlmThinkMessage
 * @description Message shape the ReAct loop passes to `llmThink`. Structural superset
 *   of { role, content } so native `tool` messages and assistant tool_calls echoes
 *   survive the loop untouched; `content` is nullable for assistant messages that
 *   carry only tool_calls.
 */
export type LlmThinkMessage = {
  role: string
  content?: string | null
  tool_call_id?: string
}

/**
 * @typedef {Object} NativeToolCall
 * @description One tool invocation the model requested via native `tool_calls`.
 */
export type NativeToolCall = {
  id: string
  toolName: string
  rawArguments: string
}

/**
 * @typedef {Object} NativeToolCallsResult
 * @description Think result when the model answered with native `tool_calls` instead
 *   of content JSON. Carries the parsed calls plus the raw assistant message so the
 *   loop can echo it back before appending `tool` role messages (the chat API requires
 *   each tool_call to be answered by a {role:"tool"} message).
 */
export type NativeToolCallsResult = {
  action: "native_tool_call"
  toolCalls: NativeToolCall[]
  assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam
}

/** @typedef {SubAgentThought | NativeToolCallsResult} ThinkResult - Discriminated think() output. */
export type ThinkResult = SubAgentThought | NativeToolCallsResult

/**
 * @typedef {Object} ThinkOptions
 * @description Optional think() request options. When `tools` is present, the API is
 *   called with native function tools; empty registries must omit it entirely.
 */
export type ThinkOptions = {
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
}

/** @typedef {Object} HistoryEntry - One tool invocation recorded during the ReAct loop. */
type HistoryEntry = {
  toolName: string
  result: { success: boolean; error?: string; errorKind?: "transient" | "permanent"; metadata: { source: string; latencyMs: number }; data?: unknown }
}

/**
 * @function summarizeData
 * @description Compresses a single tool result payload to a short string for LLM context.
 *   Large datasets become statistical/structural summaries; small values pass through.
 * @param {unknown} data - Raw tool result data.
 * @returns {unknown} Summary string, the value itself, or undefined for empty data.
 */
function summarizeData(data: unknown): unknown {
  if (data === undefined || data === null) return undefined
  if (Array.isArray(data)) {
    if (data.length === 0) return "[] (empty)"
    const first = data[0]
    if (typeof first === "number") {
      const nums = data as number[]
      return `count=${nums.length}, min=${Math.min(...nums)}, max=${Math.max(...nums)}, last=${nums[nums.length - 1]}`
    }
    if (typeof first === "string") {
      const strings = data as string[]
      return `count=${strings.length}, first=${strings.slice(0, 3).join(", ")}${strings.length > 3 ? "..." : ""}`
    }
    if (typeof first === "object" && first !== null) {
      return `count=${data.length}, keys=[${Object.keys(first).join(", ")}]`
    }
    return `count=${data.length}`
  }
  if (typeof data === "object") {
    const str = JSON.stringify(data)
    if (str.length <= 200) return data
    const entries = Object.entries(data as Record<string, unknown>)
    const preview = entries
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 50) : String(v)}`)
      .join("; ")
    return `keys=[${entries.map(([k]) => k).join(", ")}], preview=${preview}`
  }
  return data
}

/**
 * @function summarizeHistory
 * @description Maps the internal history into LLM-safe form: each entry's raw `data` is
 *   replaced by a compact `dataSummary`. The original history is NOT mutated — raw data
 *   stays in memory for dataSources/error reporting in the final FactorReport.
 * @param {HistoryEntry[]} history - Full internal tool history.
 * @returns {Array<{ toolName: string; result: { success: boolean; error?: string; errorKind?: "transient" | "permanent"; metadata: { source: string; latencyMs: number }; dataSummary?: unknown } }>}
 */
function summarizeHistory(history: HistoryEntry[]) {
  return history.map((h) => {
    const dataSummary = summarizeData(h.result.data)
    return {
      toolName: h.toolName,
      result: {
        success: h.result.success,
        error: h.result.error,
        ...(h.result.errorKind ? { errorKind: h.result.errorKind } : {}),
        metadata: h.result.metadata,
        ...(dataSummary === undefined ? {} : { dataSummary }),
      },
    }
  })
}

/**
 * @function executeToolCall
 * @description Validates params against the tool's Zod schema, executes the tool, and
 *   records the outcome (success or error) into the loop history. Never throws —
 *   unknown tools, invalid params, and execution failures become error history entries.
 * @param {string} toolName - Tool name to invoke.
 * @param {unknown} params - Raw parameters (validated before execution).
 * @param {ToolRegistry} tools - Tool registry to resolve the tool from.
 * @param {string[]} toolNames - Available tool names (for the unknown-tool error).
 * @param {HistoryEntry[]} history - Loop history to append the outcome to.
 * @returns {Promise<HistoryEntry["result"]>} The recorded tool result.
 */
async function executeToolCall(
  toolName: string,
  params: unknown,
  tools: ToolRegistry,
  toolNames: string[],
  history: HistoryEntry[]
): Promise<HistoryEntry["result"]> {
  const tool = tools[toolName]
  if (!tool) {
    const result = {
      success: false,
      error: `Unknown tool: ${toolName}. Available: ${toolNames.join(", ")}`,
      errorKind: "permanent" as const,
      metadata: { source: "system", latencyMs: 0 },
    }
    history.push({ toolName, result })
    return result
  }

  try {
    const parsed = tool.parameters.safeParse(params)
    if (!parsed.success) {
      const result = {
        success: false,
        error: `Invalid params: ${parsed.error.message}`,
        errorKind: "permanent" as const,
        metadata: { source: "system", latencyMs: 0 },
      }
      history.push({ toolName, result })
      return result
    }
    const toolResult = await tool.execute(parsed.data)
    const result = {
      success: toolResult.success,
      error: toolResult.error,
      metadata: toolResult.metadata,
      data: toolResult.data,
    }
    history.push({ toolName, result })
    return result
  } catch (err) {
    const result = {
      success: false,
      error: `Execution error: ${String(err)}`,
      errorKind: "transient" as const,
      metadata: { source: "system", latencyMs: 0 },
    }
    history.push({ toolName, result })
    return result
  }
}

/**
 * @function runSubagent
 * @description Executes the generic ReAct loop for a single factor subagent.
 *
 * The loop:
 *   1. Builds a context message (system prompt + current state + history).
 *   2. Calls `llmThink` to get a `ThinkResult` (native tool_calls or SubAgentThought).
 *   3. If `action === "return"`, assembles and returns a `FactorReport`.
 *   4. If `action === "native_tool_call"`, executes each tool, echoes the assistant
 *      message, appends {role:"tool"} results, and loops.
 *   5. If `action === "tool_call"` (backward-compat JSON convention), validates params,
 *      executes the tool, pushes the result into conversation history, and loops.
 *   6. If the loop budget (`maxLoops`) or wall-clock budget (`timeoutMs`) is
 *      exhausted, force-returns with whatever history was collected.
 *   7. Duplicate-action detection forces early stop if the same tool+params is repeated.
 *
 * @param {Object} params - Configuration for the subagent run.
 * @param {string} params.factor - The factor name (e.g. "technical").
 * @param {ToolRegistry} params.tools - Map of tool names to ToolDefinitions.
 * @param {string} params.instruction - Natural-language instruction for the subagent.
 * @param {string} params.asset - Asset ticker or identifier.
 * @param {number} [params.maxLoops=3] - Maximum THINK→ACT iterations.
 * @param {number} [params.timeoutMs=60000] - Wall-clock timeout in milliseconds.
 * @param {(messages: Array<LlmThinkMessage>, options?: ThinkOptions) => Promise<ThinkResult>} params.llmThink
 *   Function that sends a message array to the LLM and returns a ThinkResult. Receives
 *   an optional options object carrying native tools when the registry is non-empty.
 * @param {(factor: string, tools: ToolRegistry, instruction: string) => string} params.getSystemPrompt
 *   Factory that returns the system prompt for a given factor, toolset, and instruction.
 * @returns {Promise<FactorReport>} The subagent's final report.
 */
export async function runSubagent(params: {
  factor: string
  tools: ToolRegistry
  instruction: string
  asset: string
  maxLoops?: number
  timeoutMs?: number
  llmThink: (messages: LlmThinkMessage[], options?: ThinkOptions) => Promise<ThinkResult>
  getSystemPrompt: (factor: string, tools: ToolRegistry, instruction: string) => string
}): Promise<FactorReport> {
  const maxLoops = params.maxLoops ?? 3
  const timeoutMs = params.timeoutMs ?? 60000
  const history: HistoryEntry[] = []
  const toolNames = Object.keys(params.tools)

  // reason: an empty registry (e.g. technical without a candleMap) must not send a
  // `tools` field — pass no options so think() stays on the JSON-in-prompt convention.
  const openaiTools = toolRegistryToOpenAITools(params.tools)
  const thinkOptions: ThinkOptions | undefined = openaiTools.length > 0 ? { tools: openaiTools } : undefined

  // reason: native tool calls must be answered with {role:"tool"} messages; the
  // assistant tool_call message is echoed so the chat API sees a complete turn.
  // Cast only at this boundary — the API-shaped message is otherwise opaque to the loop.
  const toolMessages: LlmThinkMessage[] = []

  const startTime = Date.now()
  const lastCallFingerprint = new Map<string, string>()

  reactLoop: for (let i = 0; i < maxLoops; i++) {
    const loopStart = Date.now()
    if (loopStart - startTime > timeoutMs) break

    const systemPrompt = params.getSystemPrompt(params.factor, params.tools, params.instruction)
    const contextMessages: LlmThinkMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          factor: params.factor,
          asset: params.asset,
          instruction: params.instruction,
          remainingLoops: maxLoops - i - 1,
          availableTools: toolNames,
          history: summarizeHistory(history),
        }),
      },
    ]

    // THINK
    const thought = await params.llmThink([...contextMessages, ...toolMessages], thinkOptions)

    if (thought.action === "return") {
      const factor = params.factor as FactorReport["factor"]
      return {
        factor,
        score: thought.score,
        confidence: thought.confidence,
        signals: thought.signals.map(normalizeSignal),
        dataSources: [...new Set(history.map((h) => h.result.metadata.source))],
        reasoning: thought.reasoning,
        iterations: i + 1,
        conclusion: thought.conclusion,
        errors: history.filter((h) => !h.result.success).map((h) => {
          const prefix = h.result.errorKind ? `[${h.result.errorKind}] ` : ""
          return `${prefix}${h.toolName}: ${h.result.error || "unknown error"}`
        }),
      }
    }

    // ACT — native tool_calls: execute each call, feed results back as API-level tool messages
    if (thought.action === "native_tool_call") {
      toolMessages.push(thought.assistantMessage as unknown as LlmThinkMessage)
      for (const tc of thought.toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(tc.rawArguments)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          }
        } catch {
          // reason: malformed arguments — keep {} so zod's safeParse reports the
          // failure back to the model via the tool message error below.
        }

        const fingerprint = `${tc.toolName}::${JSON.stringify(args)}`
        if (lastCallFingerprint.get(tc.toolName) === fingerprint) {
          history.push({
            toolName: tc.toolName,
            result: {
              success: false,
              error: "Duplicate tool call detected — agent stuck in loop. Forcing stop.",
              errorKind: "permanent",
              metadata: { source: "system", latencyMs: 0 },
            },
          })
          break reactLoop
        }
        lastCallFingerprint.set(tc.toolName, fingerprint)

        const result = await executeToolCall(tc.toolName, args, params.tools, toolNames, history)
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ success: result.success, error: result.error, data: summarizeData(result.data) }),
        })
      }
      continue
    }

    // ACT — backward-compat JSON-convention tool_call (no native tools passed)
    const fingerprint = `${thought.toolName}::${JSON.stringify(thought.params)}`
    if (lastCallFingerprint.get(thought.toolName) === fingerprint) {
      history.push({
        toolName: thought.toolName,
        result: {
          success: false,
          error: "Duplicate tool call detected — agent stuck in loop. Forcing stop.",
          errorKind: "permanent",
          metadata: { source: "system", latencyMs: 0 },
        },
      })
      break reactLoop
    }
    lastCallFingerprint.set(thought.toolName, fingerprint)

    await executeToolCall(thought.toolName, thought.params, params.tools, toolNames, history)
  }

  // Force return on last loop or timeout — ask LLM one final time for a conclusion
  try {
    const systemPrompt = params.getSystemPrompt(params.factor, params.tools, params.instruction)
    // reason: no tools and no toolMessages on the force-return call — the model is
    // asked to conclude, not to invoke more tools, so a content JSON return is forced.
    const forceReturnMessages: LlmThinkMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          factor: params.factor,
          asset: params.asset,
          instruction: params.instruction,
          remainingLoops: 0,
          availableTools: toolNames,
          history: summarizeHistory(history),
          forceReturn: true,
          message:
            "This is your final opportunity. You MUST return a conclusion now. Provide your best analysis based on the data collected so far, even if incomplete. Do NOT request tools. You MUST return with score (0-100), confidence (0-100), signals, reasoning, and conclusion.",
        }),
      },
    ]

    const finalThought = await params.llmThink(forceReturnMessages)

    if (finalThought.action === "return") {
      const factor = params.factor as FactorReport["factor"]
      return {
        factor,
        score: finalThought.score,
        confidence: finalThought.confidence,
        signals: finalThought.signals.map(normalizeSignal),
        dataSources: [...new Set(history.map((h) => h.result.metadata.source))],
        reasoning: finalThought.reasoning,
        iterations: maxLoops,
        conclusion: finalThought.conclusion,
        errors: history.filter((h) => !h.result.success).map((h) => {
          const prefix = h.result.errorKind ? `[${h.result.errorKind}] ` : ""
          return `${prefix}${h.toolName}: ${h.result.error || "unknown error"}`
        }),
      }
    }
  } catch {
    // fall through to nulls below
  }

  const factor = params.factor as FactorReport["factor"]
  return {
    factor,
    score: null,
    confidence: null,
    signals: [],
    dataSources: [...new Set(history.map((h) => h.result.metadata.source))],
    reasoning: `Completed ${history.length} tool calls across ${maxLoops} iterations without returning.`,
    iterations: maxLoops,
    conclusion: "Subagent did not return a conclusion — force returned after max loops.",
    errors: history.filter((h) => !h.result.success).map((h) => {
      const prefix = h.result.errorKind ? `[${h.result.errorKind}] ` : ""
      return `${prefix}${h.toolName}: ${h.result.error || "unknown error"}`
    }),
  }
}
