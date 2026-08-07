/**
 * @file shared/llm-helpers.ts
 * @description Shared LLM helper functions: thought normalization and Zod error
 *   formatting for retry prompts.
 * @module shared
 * @layer util
 */

import type { z } from "zod"

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
