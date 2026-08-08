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
 * @note Uses CoT ordering — reasoning field is first in JSON schema to enforce step-by-step thinking before action selection.
 */
export const THINK_JSON_INSTRUCTION = `Respond ONLY with valid JSON. No markdown, no code fences. Do NOT use XML tags or <invoke> blocks — tool calls are expressed via the "action": "tool_call" field.
Output MUST match this schema:
\`\`\`json
{
  "reasoning": "...",  // ALWAYS REQUIRED (mandatory explanation of this step)
  "action": "return" | "tool_call",
  "score": 0-100,      // required when action is "return"
  "confidence": 0-100, // required when action is "return"
  "signals": [...],    // required when action is "return"
  "conclusion": "...", // required when action is "return"
  "toolName": "...",   // required when action is "tool_call"
  "params": { ... }    // required when action is "tool_call"
}
\`\`\`
Think step by step in the reasoning field before deciding on an action. Do NOT fabricate data. If a tool returns no data, state it explicitly in reasoning.`

registerPrompt("DD_THINK_JSON_INSTRUCTION", THINK_JSON_INSTRUCTION)

/**
 * @function REACT_SYSTEM_PROMPT
 * @description Builds a system prompt for a factor subagent's THINK step. Describes the
 *   factor role, the analysis instruction, and all available tools with their parameter schemas.
 * @note Uses CoT ordering — reasoning field is first in JSON schema to enforce step-by-step thinking before action selection.
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

Respond ONLY with valid JSON. No markdown, no code fences. Do NOT use XML tags or <invoke> blocks — tool calls are expressed via the "action": "tool_call" field. Output MUST match this schema:
\`\`\`json
{
  "reasoning": "...",  // ALWAYS REQUIRED for BOTH actions
  "action": "tool_call" | "return",
  "toolName": "...",   // required when action is "tool_call"
  "params": { ... },   // required when action is "tool_call"
  "score": 0-100,      // required when action is "return"
  "confidence": 0-100, // required when action is "return"
  "signals": [...],    // required when action is "return"
  "conclusion": "..."  // required when action is "return"
}
\`\`\`
Think step by step in the reasoning field before deciding on an action. Do NOT fabricate data. If a tool returns no data, state it explicitly in reasoning.

Choose one:
1. To call a tool: set "action" to "tool_call" with "reasoning", "toolName" and "params".
2. To return your analysis: set "action" to "return" with "reasoning", "score", "confidence", "signals", and "conclusion".

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
 *   determine which subagents to deploy and their instructions based on asset.
 * @note Includes two few-shot examples to guide the model toward specific, actionable subagent instructions.
 */
export const PLAN_PROMPT = `You are a senior analyst coordinating a due diligence analysis. Given an asset, determine which subagents to deploy.

For each active factor, provide:
- factor: the factor name
- instruction: specific analysis instructions for that factor
- priority: 1-4 (1 highest)

Example instruction for technical factor:
"Use compute_atr to verify current volatility and check RSI divergence on 1h chart."
Example instruction for onchain factor:
"Check whale wallet movements in the last 24h using the onchain tool, then verify exchange inflows."

Return a JSON array: [{factor, instruction, priority}, ...]`

registerPrompt("DD_PLAN", PLAN_PROMPT)

/**
 * @constant REPLAN_PROMPT
 * @description System prompt for the Main Agent's EVALUATE→RE-DEPLOY step. Instructs the
 *   LLM to generate targeted instructions for low-confidence factors.
 * @note Instructs the model to name a specific tool, explains why previous analysis was insufficient, and provides a few-shot example.
 */
export const REPLAN_PROMPT = `You are re-deploying subagents that returned low-confidence results. Given the previous reports, provide new targeted instructions for each low-confidence factor.

Your new instruction must explicitly name which tool to call first and why the previous analysis was insufficient.

For each active factor, provide:
- factor: the factor name
- instruction: specific analysis instructions for that factor
- priority: 1-4 (1 highest)

Example instruction:
"Previous sentiment score lacked twitter data. Use social_sentiment_tool to analyze mentions from the last 24h."

Return a JSON array: [{factor, instruction, priority}, ...]`

registerPrompt("DD_REPLAN", REPLAN_PROMPT)

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the Main Agent's AGGREGATE step. Instructs the LLM to
 *   merge FactorReports into a consolidated thesis with cross-validation, risks, and catalysts.
 * @note Includes explicit negative constraint against ignoring contradictions between factors.
 */
export const AGGREGATE_PROMPT = `You are a senior investment analyst. Synthesize the factor analysis reports into a unified assessment.

If factors show contradictory signals, you MUST list them in the contradictions array. Do NOT ignore contradictions.

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
