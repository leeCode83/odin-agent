/**
 * @file due-diligence/subagent.ts
 * @description Generic ReAct loop (THINK → ACT → OBSERVE → REFLECT) for factor subagents.
 *   Each subagent receives tools, an instruction, and an asset, then loops until
 *   the LLM returns a final judgment or the iteration/timeout budget is exhausted.
 * @module due-diligence
 * @layer service
 */

import { z } from "zod"
import type { FactorReport } from "@/lib/agent/due-diligence/types"
import type { ToolRegistry } from "@/lib/agent/tools/types"

/**
 * @constant SubAgentThoughtSchema
 * @description Zod discriminated union for the LLM's THINK output.
 *   - `tool_call`: the LLM wants to invoke a tool.
 *   - `return`: the LLM has reached a conclusion and returns.
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
    signals: z.array(
      z.object({
        name: z.string(),
        strength: z.number().int().min(0).max(100),
        direction: z.enum(["bullish", "bearish", "neutral"]),
      })
    ),
    reasoning: z.string(),
    conclusion: z.string(),
  }),
])

/** @typedef {z.infer<typeof SubAgentThoughtSchema>} SubAgentThought */
export type SubAgentThought = z.infer<typeof SubAgentThoughtSchema>

/**
 * @function runSubagent
 * @description Executes the generic ReAct loop for a single factor subagent.
 *
 * The loop:
 *   1. Builds a context message (system prompt + current state + history).
 *   2. Calls `llmThink` to get a `SubAgentThought`.
 *   3. If `action === "return"`, assembles and returns a `FactorReport`.
 *   4. If `action === "tool_call"`, validates params, executes the tool, pushes
 *      the result into conversation history, and loops.
 *   5. If the loop budget (`maxLoops`) or wall-clock budget (`timeoutMs`) is
 *      exhausted, force-returns with whatever history was collected.
 *
 * @param {Object} params - Configuration for the subagent run.
 * @param {string} params.factor - The factor name (e.g. "technical").
 * @param {ToolRegistry} params.tools - Map of tool names to ToolDefinitions.
 * @param {string} params.instruction - Natural-language instruction for the subagent.
 * @param {string} params.asset - Asset ticker or identifier.
 * @param {number} [params.maxLoops=3] - Maximum THINK→ACT iterations.
 * @param {number} [params.timeoutMs=60000] - Wall-clock timeout in milliseconds.
 * @param {(messages: Array<{ role: string; content: string }>) => Promise<SubAgentThought>} params.llmThink
 *   Function that sends a message array to the LLM and returns a parsed SubAgentThought.
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
  llmThink: (messages: Array<{ role: string; content: string }>) => Promise<SubAgentThought>
  getSystemPrompt: (factor: string, tools: ToolRegistry, instruction: string) => string
}): Promise<FactorReport> {
  const maxLoops = params.maxLoops ?? 3
  const timeoutMs = params.timeoutMs ?? 60000
  const history: Array<{ toolName: string; result: { success: boolean; error?: string; metadata: { source: string; latencyMs: number } } }> = []
  const toolNames = Object.keys(params.tools)

  const startTime = Date.now()

  for (let i = 0; i < maxLoops; i++) {
    const loopStart = Date.now()
    if (loopStart - startTime > timeoutMs) break

    const systemPrompt = params.getSystemPrompt(params.factor, params.tools, params.instruction)
    const contextMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          factor: params.factor,
          asset: params.asset,
          instruction: params.instruction,
          remainingLoops: maxLoops - i - 1,
          availableTools: toolNames,
          history,
        }),
      },
    ]

    // THINK
    const thought = await params.llmThink(contextMessages)

    if (thought.action === "return") {
      const factor = params.factor as FactorReport["factor"]
      return {
        factor,
        score: thought.score,
        confidence: thought.confidence,
        signals: thought.signals,
        dataSources: [...new Set(history.map((h) => h.result.metadata.source))],
        reasoning: thought.reasoning,
        iterations: i + 1,
        conclusion: thought.conclusion,
        errors: history.filter((h) => !h.result.success).map((h) => `${h.toolName}: ${h.result.error || "unknown error"}`),
      }
    }

    // ACT — execute the chosen tool
    const tool = params.tools[thought.toolName]
    if (!tool) {
      history.push({
        toolName: thought.toolName,
        result: {
          success: false,
          error: `Unknown tool: ${thought.toolName}. Available: ${toolNames.join(", ")}`,
          metadata: { source: "system", latencyMs: 0 },
        },
      })
      continue
    }

    try {
      const parsed = tool.parameters.safeParse(thought.params)
      if (!parsed.success) {
        history.push({
          toolName: thought.toolName,
          result: {
            success: false,
            error: `Invalid params: ${parsed.error.message}`,
            metadata: { source: "system", latencyMs: 0 },
          },
        })
        continue
      }
      const toolResult = await tool.execute(parsed.data)
      history.push({
        toolName: thought.toolName,
        result: {
          success: toolResult.success,
          error: toolResult.error,
          metadata: toolResult.metadata,
        },
      })
    } catch (err) {
      history.push({
        toolName: thought.toolName,
        result: {
          success: false,
          error: `Execution error: ${String(err)}`,
          metadata: { source: "system", latencyMs: 0 },
        },
      })
    }
  }

  // Force return on last loop or timeout — build from whatever history we have
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
    errors: history.filter((h) => !h.result.success).map((h) => `${h.toolName}: ${h.result.error || "unknown error"}`),
  }
}
