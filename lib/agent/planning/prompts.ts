/**
 * @file planning/prompts.ts
 * @description Prompt builders and constants for the multi-perspective planning
 *   swarm — the perspective subagent ReAct system prompt (spec §7.2), the
 *   aggregator prompt (§7.4), and the fixed-perspective instruction templates
 *   (SA5). The orchestrator PLAN/RE-PLAN step is deterministic (no LLM prompt).
 * @module planning
 * @layer service
 */

import { describeZodSchema } from "@/lib/agent/due-diligence/prompts"
import type { CompactDDReport } from "./utils"
import type { DDReport } from "@/lib/agent/types"

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
  "side": "long" | "short" | "no_trade", // required when action is "return"
  "signals": [...], // required when action is "return"
  "conclusion": "...", // required when action is "return"
  "risk_flags_text": "..." // optional free-text risk narrative when action is "return"
}
\`\`\`
Think step by step in the reasoning field before deciding on an action. Do NOT invent price levels — entry, stop-loss, take-profit, position size, and leverage are computed deterministically by the risk-engine tools (get_mark_price, compute_sltp, compute_position_size); you only choose the side and call the tools. Never output a number you did not read from a tool result, and never output entry_price / stop_loss / take_profit / position_size / leverage / score / confidence at all — those fields are not part of your output schema.

Failure policy — tools and APIs can fail. When a tool or API fails:
1. Try a reasonable fallback indicator or derived value first (e.g., mark price from a different source, ATR from an alternate timeframe).
2. Explicitly note the fallback in the reasoning field and mark the analysis degraded.
3. Only when data is genuinely unavailable AFTER fallback may you set side to no_trade.

Failure states to distinguish:
- DATA_UNAVAILABLE: no data at all, even after fallback → you may set side to no_trade.
- DATA_STALE: data is old but present → analyze it anyway, note the staleness, mark the analysis degraded.
- PARTIAL_DATA: some factors are missing → analyze what exists, note the gap, mark the analysis degraded.

Direction guidance: When bearish signals dominate (multiple bearish direction signals with strength > 60), the correct side is "short", not "no_trade". no_trade means the asset is not worth trading in either direction — it does NOT mean "uncertain about direction". If the DDReport shows bearish signals, consider short as the primary action. Use compute_atr and compute_sl_tp to validate short entry/exit levels the same way you would for long.

Choose one:
1. To call a tool: set "action" to "tool_call" with "reasoning", "toolName" and "params".
2. To return your analysis: set "action" to "return" with all return fields.

Use at least 2 tools before returning. Only return when you have validated the DDReport against current data.

Hard rules — never output trading numbers:
- Entry, stop-loss, take-profit, position size, and leverage are computed deterministically by the tools and the risk engine — you must NEVER include them in your output.
- "side" is your verdict: "long", "short", or "no_trade". The actual levels come from calling "get_mark_price", "compute_sltp", and "compute_position_size" — never guessed.
- If a required tool's result is unavailable or failed, try a reasonable fallback indicator or derived value first and mark the analysis degraded; return "side": "no_trade" only when data is genuinely unavailable after fallback.

When returning, the "signals" field MUST be an array of objects with:
- name (string): signal name
- strength (number 0-100): signal strength
- direction ("bullish" | "bearish" | "neutral"): signal direction

If you cannot provide full signal objects, fall back to plain strings like ["signal1", "signal2"] — they will be auto-converted.${degradedNote}`
  }
}

/**
 * @function buildDDFactorContext
 * @description Composes a one-sentence coverage summary of the DDReport's
 *   factor analysis, for embedding into orchestrator user payloads (plan /
 *   rePlan / aggregate). Replaces the hardcoded "4 factors" sentence that
 *   PLAN_PROMPT used to carry, so the coverage statement stays accurate when
 *   factors are optional, fail, or new ones get added.
 * @param {DDReport|CompactDDReport} ddReport - DD report. The
 *   `factorCoverage` field is OPTIONAL — the contract guarantees it exists
 *   only when the DD report producer emits it. When missing, this helper falls
 *   back to `Object.keys(ddReport.sections ?? {})` as the planned factors and
 *   derives usability from section scores (`typeof score === "number"`).
 * @param {"risk"|"market"} [focus] - Optional ordering focus: "risk" lists
 *   risk-related factors (risk-analysis, volatility, funding, liquidation)
 *   before technical/sentiment ones; "market" lists technical/sentiment
 *   factors first; omitted keeps the planned order unchanged (backward
 *   compatible).
 * @returns {string} One coverage sentence:
 *   - all succeeded: "DDReport covers N factors: a, b."
 *   - degraded: "DDReport covers M of N planned factors: a, b. Failed: c."
 *   - unknown: "DDReport coverage unavailable." (never throws)
 */
// reason: keyword lists drive focus ordering — name-based so future factor
// names (risk-analysis, volatility, funding, liquidation zones) stay covered
// without schema changes.
const RISK_FACTOR_KEYWORDS = ["risk", "volatil", "funding", "liquidat"]
const MARKET_FACTOR_KEYWORDS = ["technical", "sentiment"]

// reason: stable partition — the focused group leads, the rest keep their
// original relative order; undefined focus returns the input unchanged.
function orderFactorsByFocus(factors: string[], focus?: "risk" | "market"): string[] {
  if (focus === undefined) return factors
  const keywords = focus === "risk" ? RISK_FACTOR_KEYWORDS : MARKET_FACTOR_KEYWORDS
  const isFocused = (factor: string) => keywords.some((keyword) => factor.toLowerCase().includes(keyword))
  return [...factors.filter(isFocused), ...factors.filter((factor) => !isFocused(factor))]
}

export function buildDDFactorContext(
  ddReport: DDReport | CompactDDReport,
  focus?: "risk" | "market"
): string {
  // reason: factorCoverage is optional — read it defensively so this never
  // crashes while the field is absent from CompactDDReport.
  const coverage = (ddReport as CompactDDReport & {
    factorCoverage?: { plannedFactors: string[]; usableCount: number }
  }).factorCoverage

  const plannedFactors = orderFactorsByFocus(
    coverage?.plannedFactors ?? Object.keys(ddReport.sections ?? {}),
    focus
  )
  if (plannedFactors.length === 0) return "DDReport coverage unavailable."

  // reason: sections is typed with known optional keys; index it via a record
  // cast so arbitrary (incl. future) factor names stay type-safe.
  const sections = (ddReport.sections ?? {}) as Record<string, { score?: number | null } | undefined>
  const usableNames = plannedFactors.filter((factor) => typeof sections[factor]?.score === "number")
  const usableCount = coverage?.usableCount ?? usableNames.length

  // reason: usableCount >= plannedFactors.length means the failed set is not
  // derivable — per contract, emit the all-succeeded form (also covers the
  // degenerate case where no usable names are nameable).
  if (usableCount >= plannedFactors.length || usableNames.length === 0) {
    return `DDReport covers ${plannedFactors.length} factors: ${plannedFactors.join(", ")}.`
  }

  const failed = plannedFactors.filter((factor) => !usableNames.includes(factor))
  return `DDReport covers ${usableCount} of ${plannedFactors.length} planned factors: ${usableNames.join(", ")}. Failed: ${failed.join(", ")}.`
}

/**
 * @constant AGGREGATE_PROMPT
 * @description System prompt for the aggregator LLM (spec §7.4). Merges the
 *   three PerspectiveReports into NARRATIVE consensus only — side, thesis,
 *   reasoning, risk prose, and contradictions. The LLM never outputs money
 *   numbers or confidence: those are computed deterministically downstream
 *   (deterministicConfidence, computeTradeNumbers, computeProfitFeasibility).
 * @note Includes CoT reasoning steps and a negative constraint against omitting contradictions.
 */
export const AGGREGATE_PROMPT = `You are a trade plan aggregator. Merge 3 perspective reports into one narrative consensus.

Input:
- 3 PerspectiveReports (conservative, balance, aggressive)
- DDReport
- User target profit percentage

Tasks:
1. Determine consensus: do all 3 agree on side (long/short/no_trade)?
2. Synthesize thesis: combine the strongest points from each perspective
3. Flag contradictions: if perspectives disagree, note what they disagree on

Work through each step below before writing the final JSON. Do NOT omit contradictions. If perspectives disagree on side, list the disagreement explicitly.

The final side and confidence are NOT decided here — the deterministic consensus layer evaluates the perspective reports, weights them by historical reliability, and may override a no_trade majority when a strong minority signal qualifies. Never attempt to override the side yourself; your job is synthesis only. If 2+ perspectives concluded no_trade, reflect that in the reasoning and contradictions rather than forcing a trade.

All trading numbers (entry, stop-loss, take-profit, position size, leverage) and the confidence score are computed deterministically by the risk engine and consensus layers — you must NEVER output them. Do not output entry_price, stop_loss, take_profit, position_size_usdc, leverage, confidence_score, confidence_breakdown, or profit_feasible.

Return JSON with:
- side: "long" | "short" | "no_trade"
- thesis: string
- reasoning: string
- risk_flags_text: string (free-text risk narrative, informational only)
- consensus_alignment: number (0-100)
- contradictions: string[]
- no_trade_reason: string (only when side is "no_trade")`

/**
 * @interface FixedPerspectiveFacts
 * @description Interpolation-ready fact strings extracted from a DDReport for
 *   the fixed perspective instruction templates (SA5). Pre-rendered by the
 *   fixed planner so the templates stay static and safe — they never touch the
 *   raw report and cannot crash on missing fields.
 */
export interface FixedPerspectiveFacts {
  asset: string
  category: string
  scores: string
  riskHighlights: string
}

/**
 * @function CONSERVATIVE_INSTRUCTION_TEMPLATE
 * @description Static instruction template for the conservative perspective
 *   (SA5). Risk posture: skeptical, capital-preservation — validates the
 *   DDReport, prioritizes risk checks (ATR/SL safety, funding regime), and
 *   rejects the trade unless risk/reward is clearly favorable.
 * @param {FixedPerspectiveFacts} facts - Interpolated DDReport facts.
 * @returns {string} Conservative perspective instruction.
 */
export const CONSERVATIVE_INSTRUCTION_TEMPLATE = (facts: FixedPerspectiveFacts): string =>
  `Validate the DDReport for ${facts.asset} (${facts.category}) before committing. Factor scores: ${facts.scores}. Risk highlights: ${facts.riskHighlights}. Be skeptical of the DDReport's conclusions — prioritize risk validation: confirm stop-loss distance is safe with compute_atr, verify the funding regime is not extreme, and reject the trade unless risk/reward is clearly favorable. Prefer tighter stops and smaller position sizes.`

/**
 * @function BALANCE_INSTRUCTION_TEMPLATE
 * @description Static instruction template for the balance perspective (SA5).
 *   Risk posture: measured middle ground — weighs the DDReport's conclusions
 *   against current market data, checks funding and liquidation zones, and
 *   sizes the position within normal parameters.
 * @param {FixedPerspectiveFacts} facts - Interpolated DDReport facts.
 * @returns {string} Balance perspective instruction.
 */
export const BALANCE_INSTRUCTION_TEMPLATE = (facts: FixedPerspectiveFacts): string =>
  `Validate the DDReport for ${facts.asset} (${facts.category}). Factor scores: ${facts.scores}. Risk highlights: ${facts.riskHighlights}. Weigh the DDReport's conclusions against current market data — confirm direction with order book and technical tools, check funding and liquidation zones, and size the position within normal parameters. Take the trade only when the thesis holds with acceptable risk.`

/**
 * @function AGGRESSIVE_INSTRUCTION_TEMPLATE
 * @description Static instruction template for the aggressive perspective
 *   (SA5). Risk posture: high risk appetite — trusts the DDReport's thesis,
 *   prioritizes momentum/entry confirmation over risk aversion, and accepts
 *   wider stops and larger positions within risk-engine limits.
 * @param {FixedPerspectiveFacts} facts - Interpolated DDReport facts.
 * @returns {string} Aggressive perspective instruction.
 */
export const AGGRESSIVE_INSTRUCTION_TEMPLATE = (facts: FixedPerspectiveFacts): string =>
  `Trust the DDReport's thesis for ${facts.asset} (${facts.category}). Factor scores: ${facts.scores}. Risk highlights: ${facts.riskHighlights}. Prioritize upside/downside confirmation over risk aversion — confirm momentum with the current order book, use liquidation zone tools to find the best entry, and check the funding rate supports the direction. Accept higher risk: wider stops, larger position sizes within risk-engine limits, and act on strength rather than waiting for perfect confirmation.`
