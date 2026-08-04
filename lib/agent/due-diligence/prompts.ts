/**
 * @file due-diligence/prompts.ts
 * @description System prompts, JSON schema summaries, and schema descriptions for the due-diligence LLM layer.
 * @module due-diligence
 * @layer service
 */

import { registerPrompt } from "@/lib/agent/due-diligence/prompt-registry"

/**
 * @function describeZodSchema
 * @description Converts a Zod schema to a human-readable parameter string for LLM prompts.
 *   Handles ZodObject by extracting shape keys. Returns "{}" for unknown types.
 *   Exported for reuse by the planning swarm prompts (T4).
 * @param {unknown} schema - The Zod schema to describe.
 * @returns {string} Human-readable parameter description.
 */
export function describeZodSchema(schema: unknown): string {
  const def = (schema as Record<string, unknown>)?._def as Record<string, unknown> | undefined
  if (def?.type === "object") {
    const shape = def.shape as Record<string, unknown>
    return "{" + Object.keys(shape).join(", ") + "}"
  }
  return "{}"
}

/**
 * @constant THINK_JSON_INSTRUCTION
 * @description Explicit JSON-only output instruction appended to the THINK step's user message.
 *   DeepSeek json_object mode requires the prompt to explicitly demand JSON; the codeblock
 *   summarizes every field of the SubAgentThought discriminated union so the model reproduces it.
 */
export const THINK_JSON_INSTRUCTION = `Respond ONLY with valid JSON. No markdown, no code fences.
Output MUST match this schema:
\`\`\`json
{
  "action": "return" | "tool_call",
  "score": 0-100,
  "confidence": 0-100,
  "signals": [...],
  "reasoning": "...",
  "conclusion": "...",
  "toolName": "...", // tool_call only
  "params": { ... }  // tool_call only
}
\`\`\``

registerPrompt("DD_THINK_JSON_INSTRUCTION", THINK_JSON_INSTRUCTION)

/**
 * @function REACT_SYSTEM_PROMPT
 * @description Builds a system prompt for a factor subagent's THINK step. Describes the
 *   factor role, the analysis instruction, and all available tools with their parameter schemas.
 * @param {string} factor - The due diligence factor name (e.g. "technical", "onchain").
 * @param {Record<string, { description: string; parameters: unknown }>} tools - Map of tool names to their definitions with description and parameters.
 * @param {string} instruction - Natural-language instruction scoping the analysis.
 * @returns {string} Complete system prompt for the THINK step.
 */
export function REACT_SYSTEM_PROMPT(
  factor: string,
  tools: Record<string, { description: string; parameters: unknown }>,
  instruction: string
): string {
  const toolDescriptions = Object.entries(tools)
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join("\n")

  let factorContext = ""
  switch (factor) {
    case "technical":
      factorContext = "Focus on price action, volume, momentum indicators (RSI, MACD), support/resistance levels, and chart patterns."
      break
    case "onchain":
      factorContext = "Focus on network activity, wallet balances, transaction volumes, miner behavior, exchange inflows/outflows, and holder distribution."
      break
    case "sentiment":
      factorContext = "Focus on social media trends, news sentiment, search volume, funding rates, and fear/greed indicators."
      break
    case "fundamental":
      factorContext = "Focus on tokenomics, protocol revenue, team activity, github commits, partnerships, and market positioning."
      break
    default:
      factorContext = "Analyze relevant data points for this factor."
  }

  return `You are a ${factor} analysis agent. Analyze the asset using the available tools.
Context: ${factorContext}

INSTRUCTION: ${instruction}

Available tools:
${toolDescriptions}

Respond ONLY with valid JSON. No markdown, no code fences. Output MUST match this schema:
\`\`\`json
{
  "action": "tool_call" | "return",
  "toolName": "...",   // required when action is "tool_call"
  "params": { ... },   // required when action is "tool_call"
  "score": 0-100,      // required when action is "return"
  "confidence": 0-100, // required when action is "return"
  "signals": [...],    // required when action is "return"
  "reasoning": "...",
  "conclusion": "..."  // required when action is "return"
}
\`\`\`
Choose one:
1. To call a tool: set "action" to "tool_call" with "toolName" and "params".
2. To return your analysis: set "action" to "return" with "score", "confidence", "signals", "reasoning", "conclusion".

Use tools to gather data. Return when you have enough information for a thorough analysis.

IMPORTANT: You should use at least 2 different tools before returning. Only return if you have sufficient data.

When returning, the "signals" field MUST be an array of objects with:
- name (string): signal name, e.g. "RSI oversold"
- strength (number 0-100): signal strength
- direction ("bullish" | "bearish" | "neutral"): signal direction

If you cannot provide full signal objects, fall back to plain strings like ["signal1", "signal2"] — they will be auto-converted.`
}

/**
 * @constant PLAN_PROMPT
 * @description System prompt for the Main Agent's PLAN step. Instructs the LLM to
 *   determine which subagents to deploy and their instructions based on asset and category.
 */
export const PLAN_PROMPT = `You are a senior analyst coordinating a due diligence analysis. Given an asset and its category, determine which subagents to deploy.

For each active factor, provide:
- factor: the factor name
- instruction: specific analysis instructions for that factor
- priority: 1-4 (1 highest)

IMPORTANT: If the category is "meme", skip the fundamental factor — memecoins have no relevant fundamental data.

Return a JSON array: [{factor, instruction, priority}, ...]`

registerPrompt("DD_PLAN", PLAN_PROMPT)

/**
 * @constant REPLAN_PROMPT
 * @description System prompt for the Main Agent's EVALUATE→RE-DEPLOY step. Instructs the
 *   LLM to generate targeted instructions for low-confidence factors.
 */
export const REPLAN_PROMPT = `You are re-deploying subagents that returned low-confidence results. Given the previous reports, provide new targeted instructions for each low-confidence factor.

For each active factor, provide:
- factor: the factor name
- instruction: specific analysis instructions for that factor
- priority: 1-4 (1 highest)

Return a JSON array: [{factor, instruction, priority}, ...]`

registerPrompt("DD_REPLAN", REPLAN_PROMPT)

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the Main Agent's AGGREGATE step. Instructs the LLM to
 *   merge FactorReports into a consolidated thesis with cross-validation, risks, and catalysts.
 */
export const AGGREGATE_PROMPT = `You are a senior investment analyst. Synthesize the factor analysis reports into a unified assessment.

Respond ONLY with valid JSON. Output MUST match this schema:
\`\`\`json
{
  "thesis": "...",
  "crossValidation": {
    "pairs": [{ "factorA": "...", "factorB": "...", "alignment": 0-100, "note": "..." }],
    "overallAlignment": 0-100,
    "contradictions": []
  },
  "risks": [{ "factor": "...", "description": "...", "severity": "low" | "medium" | "high" }],
  "catalysts": [{ "factor": "...", "description": "...", "impact": "low" | "medium" | "high" }],
  "summary": "..."
}
\`\`\``

registerPrompt("DD_AGGREGATE", AGGREGATE_PROMPT)
