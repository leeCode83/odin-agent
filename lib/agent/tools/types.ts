/**
 * @file tools/types.ts
 * @description Core type definitions for the tool system used by DD Agent subagents,
 *   plus conversion to OpenAI/DeepSeek native function-tool format.
 * @module tools
 * @layer util
 */

import { z } from "zod"
import type OpenAI from "openai"

/**
 * @interface ToolResult
 * @description Standard result returned by any tool execution.
 */
export interface ToolResult {
  success: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
  error?: string
  metadata: {
    source: string
    latencyMs: number
  }
}

/**
 * @interface ToolDefinition
 * @description A tool that a subagent can invoke — named, described, parameterized, and executable.
 * @template TParams - Zod schema type for parameter validation.
 */
export interface ToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  parameters: TParams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: any) => Promise<ToolResult>
}

/**
 * @typedef ToolRegistry
 * @description A record of named tool definitions, keyed by tool name.
 */
export type ToolRegistry = Record<string, ToolDefinition>

/**
 * @function toolRegistryToOpenAITools
 * @description Converts a tool registry into OpenAI/DeepSeek native function-tool
 *   definitions. Zod parameter schemas become JSON Schema via zod v4's built-in
 *   toJSONSchema (no new dependency). Returns [] for an empty registry so callers
 *   can skip the `tools` request field entirely.
 * @param {ToolRegistry} registry - Map of tool names to ToolDefinitions.
 * @returns {OpenAI.Chat.Completions.ChatCompletionTool[]} OpenAI tools array, or [] when the registry is empty.
 */
export function toolRegistryToOpenAITools(registry: ToolRegistry): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return Object.values(registry).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters) as unknown as Record<string, unknown>,
    },
  }))
}
