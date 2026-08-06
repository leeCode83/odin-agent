/**
 * @file planning/prompts.ts
 * @description Prompt builders and constants for the multi-perspective planning
 *   swarm — the perspective subagent ReAct system prompt (spec §7.2), the
 *   orchestrator PLAN prompt (§7.3), the aggregator prompt (§7.4), and the
 *   re-deploy prompt.
 * @module planning
 * @layer service
 */

import { describeZodSchema } from "@/lib/agent/due-diligence/prompts"

/**
 * @function makePlanningSystemPrompt
 * @description Builds the system prompt factory for a planning perspective
 *   subagent's ReAct THINK step (spec §7.2). The returned function matches
 *   `runSubagent`'s `getSystemPrompt(factor, tools, instruction)` signature.
 *   Mirrors the DD `REACT_SYSTEM_PROMPT` house style but adds the perspective
 *   persona, the DDReport validation role, and the planning return fields.
 * @note Uses CoT ordering — reasoning field is first in JSON schema to enforce step-by-step thinking before action selection.
 * @param {Object} options - Prompt options.
 * @param {number} options.targetProfitPercent - User's profit target (e.g. 100 = 100%).
 * @param {string[]} [options.degradedFactors] - Names of DD factors that failed
 *   (score null or missing). When non-empty, the prompt appends a degraded-DD
 *   note telling the perspective to account for missing data explicitly (F3).
 * @returns {(factor: string, tools: Record<string, { description: string; parameters: unknown }>, instruction: string) => string}
 *   System prompt builder for one perspective subagent run.
 */
export function makePlanningSystemPrompt(options: {
  targetProfitPercent: number
  degradedFactors?: string[]
}): (
  factor: string,
  tools: Record<string, { description: string; parameters: unknown }>,
  instruction: string
) => string {
  return (factor, tools, instruction) => {
    // reason: degraded-DD note (F3) — appended only when factors actually
    // failed so complete reports keep the exact pre-F3 prompt.
    const degradedNote =
      options.degradedFactors && options.degradedFactors.length > 0
        ? `\n\nNote: DD analysis incomplete — factors ${options.degradedFactors.join(", ")} failed. Account for missing data explicitly.`
        : ""
    const toolDescriptions = Object.entries(tools)
      .map(([name, tool]) => {
        const params = tool.parameters ? describeZodSchema(tool.parameters) : "{}"
        return `- ${name}(${params}): ${tool.description}`
      })
      .join("\n")

    return `You are a ${factor} trading analyst specializing in Hyperliquid perpetual futures.

Your job: analyze the provided DDReport and use available tools to formulate a trade plan. You do NOT re-analyze technical indicators (the DDReport already did that). You focus on:
1. Validating the DDReport's conclusions against current market data
2. Computing risk parameters (ATR, SL/TP, position size) using available tools
3. Checking for external factors (news, sentiment, funding regime) that might invalidate the DDReport
4. Deciding whether this trade meets the user's target profit of ${options.targetProfitPercent}%

INSTRUCTION: ${instruction}

Available tools:
${toolDescriptions}

You MUST respond in JSON format. Do NOT use XML tags or <invoke> blocks — tool calls are expressed via the "action": "tool_call" field. Output MUST match this schema:
\`\`\`json
{
  "reasoning": "...", // ALWAYS REQUIRED
  "action": "tool_call" | "return",
  "toolName": "...", // required when action is "tool_call"
  "params": {...}, // required when action is "tool_call"
  "score": <0-100>, // required when action is "return"
  "confidence": <0-100>, // required when action is "return"
  "side": "long" | "short" | "no_trade", // required when action is "return"
  "entry_price": <number>, // required when action is "return"
  "signals": [...], // required when action is "return"
  "suggested_stop_loss": <number>, // required when action is "return"
  "suggested_take_profit": <number>, // required when action is "return"
  "suggested_leverage": <number>, // required when action is "return"
  "suggested_position_size_usdc": <number>, // required when action is "return"
  "conclusion": "...", // required when action is "return"
  "risk_flags": [...] // required when action is "return"
}
\`\`\`
Think step by step in the reasoning field before deciding on an action. Do NOT invent price levels. If market data is unavailable, set entry_price to 0 and side to no_trade.

Choose one:
1. To call a tool: set "action" to "tool_call" with "reasoning", "toolName" and "params".
2. To return your analysis: set "action" to "return" with all return fields.

Use at least 2 tools before returning. Only return when you have validated the DDReport against current data.

When returning, the "signals" field MUST be an array of objects with:
- name (string): signal name
- strength (number 0-100): signal strength
- direction ("bullish" | "bearish" | "neutral"): signal direction

If you cannot provide full signal objects, fall back to plain strings like ["signal1", "signal2"] — they will be auto-converted.${degradedNote}`
  }
}

/**
 * @constant PLAN_PROMPT
 * @description System prompt for the orchestrator's PLAN step (spec §7.3).
 *   Decides which perspectives to deploy, their specific instructions, and
 *   priority order. The DDReport and targetProfitPercent arrive in the user
 *   message payload.
 * @note Includes few-shot examples to guide the model toward specific, actionable subagent instructions.
 */
export const PLAN_PROMPT = `You are a trade planning orchestrator. You manage 3 perspective subagents (conservative, balance, aggressive).

Given a DDReport and user's target profit percentage, decide:
1. Which perspectives to deploy (always all 3 for the first iteration)
2. Specific instruction for each perspective
3. Priority order (1 = highest)

The DDReport contains analysis of 4 factors: technical, onchain, sentiment, fundamental.

For each perspective, write an instruction that tells the subagent:
- What aspects of the DDReport to focus on
- What tools to prioritize (risk calc, funding check, liquidation zones, web search)
- Whether to be skeptical or trusting of the DDReport's conclusions

Example for conservative: "Validate DDReport's SL levels, use compute_atr to confirm stop distance is safe, check funding regime."
Example for aggressive: "Confirm upside momentum with current order book, use liquidation zone tool to find entry."

You MUST respond in JSON format.
Return: { "subagents": [{ "perspective": "conservative"|"balance"|"aggressive", "instruction": "...", "priority": number }] }`

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the aggregator LLM (spec §7.4). Merges the
 *   three PerspectiveReports into one final trade plan with consensus metrics,
 *   profit feasibility, and an optional no-trade reason.
 * @note Includes CoT reasoning steps and a negative constraint against omitting contradictions.
 */
export const AGGREGATE_PROMPT = `You are a trade plan aggregator. Merge 3 perspective reports into one final trade plan.

Input:
- 3 PerspectiveReports (conservative, balance, aggressive)
- DDReport
- User target profit percentage

Tasks:
1. Determine consensus: do all 3 agree on side (long/short/no_trade)?
2. Synthesize thesis: combine the strongest points from each perspective
3. Set final parameters: entry, SL, TP, leverage, position size (prefer median across perspectives)
4. Check profit feasibility: does expected profit (based on take_profit - entry) meet the user's target profit?
5. Flag contradictions: if perspectives disagree, note what they disagree on

Work through each step below before writing the final JSON. Do NOT omit contradictions. If perspectives disagree on side or leverage, list the disagreement explicitly.

If 2+ perspectives conclude no_trade, final action is no_trade.

Return JSON with:
- side: "long" | "short" | "no_trade"
- thesis: string
- reasoning: string
- confidence_score: number (0-100)
- confidence_breakdown: { factor_alignment: number (0-100), historical_match: number (0-100), signal_strength: number (0-100) }
- leverage_suggested: number
- risk_flags: string[]
- entry_price: number
- stop_loss: number
- take_profit: number
- position_size_usdc: number
- consensus_alignment: number (0-100)
- contradictions: string[]
- profit_feasible: boolean
- no_trade_reason: string (only when side is "no_trade")`

/**
 * @constant REPLAN_PROMPT
 * @description System prompt for the orchestrator's RE-PLAN step. Generates
 *   targeted new instructions for low-consensus perspectives, informed by the
 *   previous perspective reports.
 * @note Instructs the model to name a specific tool, what threshold must be met, and provides a few-shot example.
 */
export const REPLAN_PROMPT = `You are re-deploying perspective subagents that produced low-consensus results.

Given the list of low-consensus perspectives and the previous reports from all perspectives, provide new targeted instructions for each low-consensus perspective. The new instruction should:
- Point out what the previous analysis missed or over-weighted
- Suggest specific tools to re-check (risk calc, funding regime, liquidation zones, web search)
- Set a clear expectation for what a good analysis must confirm before returning
- Specify which tool the perspective must call first and what threshold must be met before returning

Example instruction:
"Previous report ignored high funding rates. Use funding_rate_check tool first. You must confirm funding rate is below 0.05% before entering long."

You MUST respond in JSON format.
Return: { "subagents": [{ "perspective": "conservative"|"balance"|"aggressive", "instruction": "...", "priority": number }] }`
