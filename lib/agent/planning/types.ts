/**
 * @file planning/types.ts
 * @description Type definitions for the multi-perspective planning swarm —
 *   perspective reports, agent plans, consensus results, and pipeline I/O.
 * @module planning
 * @layer service
 */

import { z } from "zod"
import { SignalEntrySchema } from "@/lib/agent/due-diligence/types"
import type { TradePlan, ConfidenceBreakdown, DDReport } from "@/lib/agent/types"

/**
 * @constant PerspectiveSchema
 * @description Zod schema for the allowed trading perspectives.
 */
export const PerspectiveSchema = z.enum(["conservative", "balance", "aggressive"])

/**
 * @type Perspective
 * @description Inferred type for the trading perspective.
 */
export type Perspective = z.infer<typeof PerspectiveSchema>

/**
 * @constant PerspectiveReportSchema
 * @description Zod schema for a single planning subagent's report. Mirrors
 *   FactorReport (score/confidence/signals/dataSources/...) and adds the
 *   planning fields (`side`, `entry_price`, `suggested_*`, `risk_flags`).
 *   Every planning field is required here because the LLM return schema
 *   (SubAgentThoughtSchema) declares them as optional — a subagent that
 *   produces a report is expected to fill them in.
 */
export const PerspectiveReportSchema = z.object({
  perspective: PerspectiveSchema,
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  side: z.enum(["long", "short", "no_trade"]),
  entry_price: z.number(),
  signals: z.array(SignalEntrySchema),
  dataSources: z.array(z.string()),
  reasoning: z.string(),
  iterations: z.number().int().min(0),
  conclusion: z.string(),
  errors: z.array(z.string()),
  suggested_stop_loss: z.number(),
  suggested_take_profit: z.number(),
  suggested_position_size_usdc: z.number(),
  risk_flags: z.array(z.string()),
  // reason: narrative free-text risk prose from the perspective LLM (P4 SA2) —
  // informational only, never gated on. Structured enum flags live in risk_flags.
  risk_flags_text: z.string().optional(),
})

/**
 * @type PerspectiveReport
 * @description Inferred type for a planning subagent's report.
 */
export type PerspectiveReport = z.infer<typeof PerspectiveReportSchema>

/**
 * @interface PlanningSubagentPlan
 * @description A single planning subagent deployment: which perspective to
 *   emulate, the instruction to follow, and its deployment priority.
 */
export interface PlanningSubagentPlan {
  perspective: Perspective
  instruction: string
  priority: number
}

/**
 * @interface PlanningAgentPlan
 * @description The full plan for deploying planning subagents, including the
 *   re-deployment history from previous consensus iterations.
 */
export interface PlanningAgentPlan {
  subagents: PlanningSubagentPlan[]
  reDeployHistory: ReDeployEntry[]
}

/**
 * @interface ReDeployEntry
 * @description History entry tracking a planning subagent re-deployment when
 *   consensus was low.
 */
export interface ReDeployEntry {
  perspective: string
  previousConfidence: number | null
  newInstruction: string
  iteration: number
}

/**
 * @interface ConsensusResult
 * @description Outcome of aggregating the planning subagents' reports into a
 *   single decision.
 */
export interface ConsensusResult {
  decision: "ACCEPT" | "RE-DEPLOY" | "NO_TRADE" | "FAILED"
  lowConsensusPerspectives: string[]
  contradictions: string[]
  message: string
  noTradeReason?: string
  // reason: true when the upstream DD report was partial (some factors
  // failed) — marks consensus results so NO_TRADE/RE-DEPLOY aren't mistaken
  // for real market conviction. Omitted entirely when DD was complete.
  degraded?: boolean
  // reason: transparency — every perspective's verdict, one entry each, so
  // callers can see WHO voted what and why instead of just the aggregate.
  perspectiveBreakdown: PerspectiveBreakdownEntry[]
  // reason: transparency — the deterministic rule that produced a NO_TRADE /
  // RE-DEPLOY decision (from computeNoTradeDecision). Null when the decision
  // is ACCEPT or FAILED.
  noTradeReasonDetail: NoTradeReasonDetail | null
  // reason: dynamic weighting (L1) — the weights applied to each perspective
  // for this evaluation (performance-derived, uniform during cold-start).
  weights: PerspectiveWeights
  // reason: weighted scoring (L2) — per-side score = Σ (weight × confidence),
  // used by the strong-minority override (L3) and surfaced for transparency.
  sideScores: SideScores
  // reason: strong-minority override (L3) — whether a minority signal rescued
  // the side decision from a no_trade majority, and with what confidence.
  overrideRule: OverrideRuleDetail
}

/**
 * @type PerspectiveBreakdownEntry
 * @description Per-perspective verdict used for consensus transparency:
 *   each planning subagent's side, confidence, reason, funding flag, failed
 *   tools, and degradation status.
 */
export type PerspectiveBreakdownEntry = {
  perspective: "conservative" | "balance" | "aggressive"
  side: "long" | "short" | "no_trade"
  confidence: number
  reason: string
  fundingFlag: boolean
  toolsFailed: string[]
  degraded: boolean
}

/**
 * @type NoTradeReasonDetail
 * @description The deterministic rule behind a NO_TRADE / RE-DEPLOY decision,
 *   with the confidence statistics that triggered it.
 */
export type NoTradeReasonDetail = {
  rule:
    | "NO_TRADE_LOW_AVG"
    | "NO_TRADE_UNANIMOUS_WEAK"
    | "RE_DEPLOY_STRONG_MINORITY"
    | "RE_DEPLOY_MIDDLE"
    | "NO_TRADE_UNANIMOUS"
  avgConfidence: number
  highestConfidence: number
}

/**
 * @type PerspectiveWeights
 * @description Per-perspective consensus weights (Σ = 1). Derived from
 *   historical performance when enough outcomes exist, uniform during
 *   cold-start (no history yet). Consumed by the weighted scoring layer.
 */
export type PerspectiveWeights = Record<Perspective, number>

/**
 * @type SideScores
 * @description Per-side weighted consensus scores. score(side) = Σ over
 *   perspectives siding with `side` of (weight × confidence). The no_trade
 *   score is included so callers can see how much conviction the abstentions
 *   carried, not just the traded sides.
 */
export type SideScores = Record<"long" | "short" | "no_trade", number>

/**
 * @type PerspectivePerformance
 * @description Historical reliability of one perspective from graph memory:
 *   how many closed decisions it was on the right side of, out of how many
 *   it participated in (side != no_trade).
 */
export interface PerspectivePerformance {
  correct: number
  total: number
}

/**
 * @interface ConsensusWeightConfig
 * @description Tunables for the dynamic weighting layer (L1). Plain constants,
 *   no config framework — callers pass the defaults from the consensus module.
 */
export interface ConsensusWeightConfig {
  /** Cold-start blend speed: α = 1 − e^(−t/λ), t = samples seen. Higher λ = slower trust. */
  coldStartLambda: number
  /** Max closed decisions considered per perspective performance query. */
  historyLimit: number
  /** Selective-WTA: boost the best perspective when best ≥ θ × second-best. */
  wtaThreshold: number
  /** Selective-WTA: temporary weight assigned to the dominant perspective. */
  wtaWeight: number
  /** Selective-WTA: minimum samples before the boost may apply. */
  wtaMinSamples: number
}

/**
 * @type OverrideRuleDetail
 * @description Result of the strong-minority override check (L3). When
 *   `applied` is true, the side decision was rescued from a no_trade majority
 *   by a strong minority signal; `confidence` is the deterministic
 *   post-override confidence; `triggeredBy` names the perspective that
 *   carried the signal.
 */
export type OverrideRuleDetail =
  | { applied: true; side: "long" | "short"; confidence: number; triggeredBy: string }
  | { applied: false }

/**
 * @interface DDCoverage
 * @description How much of the upstream DD analysis was usable. Present on
 *   the pipeline output only when at least one factor failed (score null or
 *   missing), so callers can distinguish "market says no" from "data says
 *   nothing".
 */
export interface DDCoverage {
  usableFactorCount: number
  totalFactors: number
  failedFactors: string[]
}

/**
 * @interface PlanningAgentInput
 * @description Input parameters for the planning swarm agent.
 *   Requires a pre-computed Due Diligence (DD) report.
 */
export interface PlanningAgentInput {
  asset: string
  userId: string
  walletAddress: string
  targetProfitPercent: number
  ddReport: DDReport
}

/**
 * @interface PlanningAgentOutput
 * @description Output of the planning swarm agent: the trade plan, per-phase
 *   timings, iteration count, and run status.
 */
export interface PlanningAgentOutput {
  report: TradePlan
  timing: {
    planMs: number
    executeMs: number
    aggregateMs: number
    evaluateMs: number
    totalMs: number
  }
  iterations: number
  // reason: how the final decision was reached — "consensus" (Layer 1 ACCEPT),
  // "forced" (re-deploy cap), "exhausted" (loop deadline), "no_trade".
  // Disambiguates a NO_TRADE born from loop exhaustion vs consensus.
  decisionPath: "consensus" | "forced" | "exhausted" | "no_trade"
  // reason: approval_required = penalized (partial DD) run whose plan needs
  // human approval; distinct from "partial" (loop exhaustion) and the
  // per-plan autonomy_decision "approve" (which can also occur on full DD).
  status: "complete" | "no_trade" | "partial" | "failed" | "approval_required"
  // reason: transparency (2c) — per-perspective breakdown and the rule that
  // produced the NO_TRADE / RE-DEPLOY decision, surfaced to API consumers.
  // Present on every run that reached evaluateConsensus (all except dd-gate
  // failures); omitted when consensus never ran.
  consensus?: {
    perspectiveBreakdown: PerspectiveBreakdownEntry[]
    noTradeReasonDetail: NoTradeReasonDetail | null
    // reason: dynamic weighting (L1) + weighted scoring (L2) + override (L3)
    // surfaced to API consumers alongside the breakdown, so the deterministic
    // layers are auditable end-to-end.
    weights: PerspectiveWeights
    sideScores: SideScores
    overrideRule: OverrideRuleDetail
  }
}

/**
 * @type PlanningAggregationLlmResult
 * @description Narrow result of the aggregation LLM: narrative only. No money
 *   numbers (entry/SL/TP/size/leverage/confidence) and no profit_feasible — the
 *   orchestrator computes all of those deterministically (deterministicConfidence,
 *   computeTradeNumbers, computeProfitFeasibility) before building the final
 *   PlanningAggregationResult. The schema deliberately rejects numeric fields.
 */
export type PlanningAggregationLlmResult = {
  side: "long" | "short" | "no_trade"
  thesis: string
  reasoning: string
  risk_flags_text: string
  consensus_alignment: number
  contradictions: string[]
  no_trade_reason?: string
}

/**
 * @type PlanningAggregationResult
 * @description Aggregated reasoning across planning perspectives, with
 *   consensus metrics and a side widened to include `no_trade`. Every numeric
 *   field is filled deterministically by the orchestrator (never the LLM): the
 *   LLM supplies only the narrative fields, and confidence_breakdown /
 *   risk_flags / prices / profit_feasible come from deterministicConfidence,
 *   mergeRiskFlags, and computeTradeNumbers.
 */
export type PlanningAggregationResult = {
  side: "long" | "short" | "no_trade"
  thesis: string
  reasoning: string
  confidence_score: number
  confidence_breakdown: ConfidenceBreakdown
  risk_flags: string[]
  consensus_alignment: number
  contradictions: string[]
  profit_feasible: boolean
  no_trade_reason?: string
  entry_price: number
  stop_loss: number
  take_profit: number
  position_size_usdc: number
}

/**
 * @interface PlanningPipelineOutput
 * @description Output of the trade planning pipeline including the plan and execution timings.
 */
export interface PlanningPipelineOutput {
  plan: TradePlan
  timing: {
    fetchMs: number
    graphMs: number
    llmMs: number
    riskEngineMs: number
    totalMs: number
  }
}
