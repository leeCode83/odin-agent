/**
 * @file planning/prompts.ts
 * @description Prompt builders and constants for the multi-perspective planning
 *   swarm — the perspective subagent ReAct system prompt (spec §7.2), the
 *   orchestrator PLAN prompt (§7.3), the aggregator prompt (§7.4), and the
 *   re-deploy prompt. Old one-shot pipeline prompts are kept and marked
 *   @deprecated until T10.
 * @module planning
 * @layer service
 */

import type { DDReport, GraphPattern } from "@/lib/agent/types"
import type { Perspective, PerspectiveResult } from "./types"
import { describeZodSchema } from "@/lib/agent/due-diligence/prompts"

const CONSERVATIVE_PROMPT = `You are a conservative trading analyst. Your analysis prioritizes capital preservation. You require strong confirmation before recommending entries. You favor smaller positions and tighter stops. You are skeptical of high-conviction signals.

Return a JSON object with:
- thesis: string (your trade thesis)
- confidence_breakdown: { factor_alignment: number (0-100), historical_match: number (0-100), signal_strength: number (0-100) }
- side: "long" | "short"
- leverage_suggested: number (1-20)
- reasoning: string (detailed reasoning)
- risk_flags: string[] (specific risk concerns)

Return ONLY valid JSON.`

const BALANCE_PROMPT = `You are a balanced trading analyst. You weigh both bullish and bearish factors objectively. You look for favorable but realistic risk-reward setups. You value data and pattern-matching equally.

Return a JSON object with:
- thesis: string (your trade thesis)
- confidence_breakdown: { factor_alignment: number (0-100), historical_match: number (0-100), signal_strength: number (0-100) }
- side: "long" | "short"
- leverage_suggested: number (1-20)
- reasoning: string (detailed reasoning)
- risk_flags: string[] (specific risk concerns)

Return ONLY valid JSON.`

const AGGRESSIVE_PROMPT = `You are an aggressive trading analyst. You focus on asymmetric upside opportunities. You accept higher risk for higher returns. You favor momentum and breakouts. You are comfortable with conviction when signals align.

Return a JSON object with:
- thesis: string (your trade thesis)
- confidence_breakdown: { factor_alignment: number (0-100), historical_match: number (0-100), signal_strength: number (0-100) }
- side: "long" | "short"
- leverage_suggested: number (1-20)
- reasoning: string (detailed reasoning)
- risk_flags: string[] (specific risk concerns)

Return ONLY valid JSON.`

/**
 * @constant PERSPECTIVE_SYSTEM_PROMPTS
 * @description Mapping of perspective types (conservative, balance, aggressive) to their system prompts.
 * @deprecated Superseded by makePlanningSystemPrompt (T4); deleted in T10.
 */
export const PERSPECTIVE_SYSTEM_PROMPTS: Record<Perspective, string> = {
  conservative: CONSERVATIVE_PROMPT,
  balance: BALANCE_PROMPT,
  aggressive: AGGRESSIVE_PROMPT,
}

/**
 * @constant AGGREGATOR_SYSTEM_PROMPT
 * @description System prompt for the aggregator LLM that synthesizes multiple perspectives.
 * @deprecated Superseded by AGGREGATE_PROMPT (T4); deleted in T10.
 */
export const AGGREGATOR_SYSTEM_PROMPT = `You are a senior portfolio manager reconciling three analyst perspectives (conservative/balance/aggressive). Synthesize them into unified trade thesis. Weigh each by strength of reasoning. Note agreement or divergence across perspectives.

Return a JSON object with:
- side: "long" | "short"
- thesis: string (unified trade thesis)
- reasoning: string (synthesis reasoning)
- confidence_score: number (0-100) — reflects both factor quality AND perspective agreement level
- confidence_breakdown: { factor_alignment: number (0-100), historical_match: number (0-100), signal_strength: number (0-100) }
- leverage_suggested: number (1-20) — consensus leverage recommendation
- risk_flags: string[] — merged and deduplicated risk concerns from all perspectives

Return ONLY valid JSON.`

/**
 * @function PERSPECTIVE_USER_PROMPT
 * @description Generates the user prompt for a perspective LLM based on the DD report and graph patterns.
 * @param {DDReport} ddReport - The due diligence report.
 * @param {GraphPattern[]} graphPatterns - Historical graph patterns.
 * @returns {string} The formatted user prompt.
 * @deprecated Superseded by the planning subagent ReAct context (T4); deleted in T10.
 */
export function PERSPECTIVE_USER_PROMPT(ddReport: DDReport, graphPatterns: GraphPattern[]): string {
  const sections = ddReport.sections
  const tech = sections.technical
  const onchain = sections.onchain
  const sentiment = sections.sentiment
  const fundamental = sections.fundamental

  const parts: string[] = []

  parts.push(`Asset: ${ddReport.asset} (${ddReport.category})`)
  parts.push(`Overall confidence score: ${ddReport.overallConfidence ?? ddReport.confidence_score}/100`)
  parts.push(`Aggregated thesis: ${ddReport.summary ?? ddReport.aggregated_thesis}`)
  parts.push("")

  if (tech) {
    parts.push("--- Technical Analysis ---")
    parts.push(`Score: ${tech.score ?? "N/A"}/100`)
    if (tech.summary) parts.push(`Summary: ${tech.summary}`)
    if (tech.signals.length > 0) parts.push(`Signals: ${tech.signals.join(", ")}`)
    parts.push("")
  }

  if (onchain) {
    parts.push("--- Onchain Analysis ---")
    parts.push(`Score: ${onchain.score ?? "N/A"}/100`)
    if (onchain.summary) parts.push(`Summary: ${onchain.summary}`)
    if (onchain.signals.length > 0) parts.push(`Signals: ${onchain.signals.join(", ")}`)
    parts.push("")
  }

  if (sentiment) {
    parts.push("--- Sentiment Analysis ---")
    parts.push(`Score: ${sentiment.score ?? "N/A"}/100`)
    if (sentiment.summary) parts.push(`Summary: ${sentiment.summary}`)
    if (sentiment.signals.length > 0) parts.push(`Signals: ${sentiment.signals.join(", ")}`)
    parts.push("")
  }

  if (fundamental) {
    parts.push("--- Fundamental Analysis ---")
    parts.push(`Score: ${fundamental.score ?? "N/A"}/100`)
    if (fundamental.summary) parts.push(`Summary: ${fundamental.summary}`)
    if (fundamental.signals.length > 0) parts.push(`Signals: ${fundamental.signals.join(", ")}`)
    parts.push("")
  }

  if (ddReport.risk_flags.length > 0) {
    parts.push("--- Risk Flags ---")
    parts.push(ddReport.risk_flags.join(", "))
    parts.push("")
  }

  if (graphPatterns.length > 0) {
    parts.push("--- Historical Graph Patterns ---")
    for (const gp of graphPatterns) {
      parts.push(`Pattern: ${gp.pattern} | Outcome: ${gp.outcome} | Frequency: ${gp.frequency}x`)
    }
    parts.push("")
  }

  parts.push("Based on the above data, provide your analysis.")

  return parts.join("\n")
}

/**
 * @function AGGREGATOR_USER_PROMPT
 * @description Generates the user prompt for the aggregator LLM based on the generated perspectives.
 * @param {PerspectiveResult[]} results - The perspective results.
 * @returns {string} The formatted user prompt.
 * @deprecated Superseded by AGGREGATE_PROMPT (T4); deleted in T10.
 */
export function AGGREGATOR_USER_PROMPT(results: PerspectiveResult[]): string {
  const parts: string[] = []

  for (const r of results) {
    parts.push(`=== ${r.perspective.toUpperCase()} PERSPECTIVE ===`)
    parts.push(`Thesis: ${r.thesis}`)
    parts.push(`Direction: ${r.side}`)
    parts.push(`Confidence breakdown: factor_alignment=${r.confidence_breakdown.factor_alignment}, historical_match=${r.confidence_breakdown.historical_match}, signal_strength=${r.confidence_breakdown.signal_strength}`)
    parts.push(`Suggested leverage: ${r.leverage_suggested}x`)
    parts.push(`Risk flags: ${r.risk_flags.join(", ")}`)
    parts.push(`Reasoning: ${r.reasoning}`)
    parts.push("")
  }

  parts.push("Synthesize the three perspectives above into a unified trade thesis. Note agreement or divergence on side. Merge risk flags across perspectives. Suggest consensus leverage.")

  return parts.join("\n")
}

/**
 * @function makePlanningSystemPrompt
 * @description Builds the system prompt factory for a planning perspective
 *   subagent's ReAct THINK step (spec §7.2). The returned function matches
 *   `runSubagent`'s `getSystemPrompt(factor, tools, instruction)` signature.
 *   Mirrors the DD `REACT_SYSTEM_PROMPT` house style but adds the perspective
 *   persona, the DDReport validation role, and the planning return fields.
 * @param {Object} options - Prompt options.
 * @param {number} options.targetProfitPercent - User's profit target (e.g. 100 = 100%).
 * @returns {(factor: string, tools: Record<string, { description: string; parameters: unknown }>, instruction: string) => string}
 *   System prompt builder for one perspective subagent run.
 */
export function makePlanningSystemPrompt(options: {
  targetProfitPercent: number
}): (
  factor: string,
  tools: Record<string, { description: string; parameters: unknown }>,
  instruction: string
) => string {
  return (factor, tools, instruction) => {
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

You MUST respond in JSON format. Choose one:
1. To call a tool: {"action": "tool_call", "toolName": "...", "params": {...}, "reasoning": "..."}
2. To return your analysis: {"action": "return", "score": <0-100>, "confidence": <0-100>, "side": "long" | "short" | "no_trade", "entry_price": <number>, "signals": [...], "suggested_stop_loss": <number>, "suggested_take_profit": <number>, "suggested_leverage": <number>, "suggested_position_size_usdc": <number>, "reasoning": "...", "conclusion": "...", "risk_flags": [...]}

Use at least 2 tools before returning. Only return when you have validated the DDReport against current data.

When returning, the "signals" field MUST be an array of objects with:
- name (string): signal name
- strength (number 0-100): signal strength
- direction ("bullish" | "bearish" | "neutral"): signal direction

If you cannot provide full signal objects, fall back to plain strings like ["signal1", "signal2"] — they will be auto-converted.`
  }
}

/**
 * @constant PLAN_PROMPT
 * @description System prompt for the orchestrator's PLAN step (spec §7.3).
 *   Decides which perspectives to deploy, their specific instructions, and
 *   priority order. The DDReport and targetProfitPercent arrive in the user
 *   message payload.
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

Return: { "subagents": [{ "perspective": "conservative"|"balance"|"aggressive", "instruction": "...", "priority": number }] }`

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the aggregator LLM (spec §7.4). Merges the
 *   three PerspectiveReports into one final trade plan with consensus metrics,
 *   profit feasibility, and an optional no-trade reason.
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
 */
export const REPLAN_PROMPT = `You are re-deploying perspective subagents that produced low-consensus results.

Given the list of low-consensus perspectives and the previous reports from all perspectives, provide new targeted instructions for each low-consensus perspective. The new instruction should:
- Point out what the previous analysis missed or over-weighted
- Suggest specific tools to re-check (risk calc, funding regime, liquidation zones, web search)
- Set a clear expectation for what a good analysis must confirm before returning

Return: { "subagents": [{ "perspective": "conservative"|"balance"|"aggressive", "instruction": "...", "priority": number }] }`
