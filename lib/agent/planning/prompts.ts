import type { DDReport, GraphPattern } from "@/lib/agent/types"
import type { Perspective, PerspectiveResult } from "./types"

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
 */
export const PERSPECTIVE_SYSTEM_PROMPTS: Record<Perspective, string> = {
  conservative: CONSERVATIVE_PROMPT,
  balance: BALANCE_PROMPT,
  aggressive: AGGRESSIVE_PROMPT,
}

/**
 * @constant AGGREGATOR_SYSTEM_PROMPT
 * @description System prompt for the aggregator LLM that synthesizes multiple perspectives.
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
