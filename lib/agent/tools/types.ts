/**
 * @file tools/types.ts
 * @description Core type definitions for the tool system used by DD Agent subagents.
 * @module tools
 * @layer util
 */

import { z } from "zod"

/**
 * @interface ToolResult
 * @description Standard result returned by any tool execution.
 */
export interface ToolResult {
  success: boolean
  data?: unknown
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
export interface ToolDefinition<TParams = z.ZodTypeAny> {
  name: string
  description: string
  parameters: TParams
  execute: (params: z.infer<TParams>) => Promise<ToolResult>
}

/**
 * @typedef ToolRegistry
 * @description A record of named tool definitions, keyed by tool name.
 */
export type ToolRegistry = Record<string, ToolDefinition>
