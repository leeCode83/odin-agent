/**
 * @file planning/types.ts
 * @description Type definitions for the multi-perspective planning swarm —
 *   perspective reports, agent plans, consensus results, and pipeline I/O.
 * @module planning
 * @layer service
 */

import { z } from "zod"
import { SignalEntrySchema } from "@/lib/agent/due-diligence/types"
import type { TradePlan, ConfidenceBreakdown } from "@/lib/agent/types"

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
  suggested_leverage: z.number(),
  suggested_position_size_usdc: z.number(),
  risk_flags: z.array(z.string()),
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
}

/**
 * @interface PlanningAgentInput
 * @description Input parameters for the planning swarm agent.
 */
export interface PlanningAgentInput {
  asset: string
  userId: string
  walletAddress: string
  targetProfitPercent: number
}

/**
 * @interface PlanningAgentOutput
 * @description Output of the planning swarm agent: the trade plan, per-phase
 *   timings, iteration count, and run status.
 */
export interface PlanningAgentOutput {
  report: TradePlan
  timing: {
    ddMs: number
    planMs: number
    executeMs: number
    aggregateMs: number
    evaluateMs: number
    totalMs: number
  }
  iterations: number
  // reason: approval_required = penalized (partial DD) run whose plan needs
  // human approval; distinct from "partial" (loop exhaustion) and the
  // per-plan autonomy_decision "approve" (which can also occur on full DD).
  status: "complete" | "no_trade" | "partial" | "failed" | "approval_required"
}

/**
 * @type PlanningAggregationResult
 * @description Aggregated reasoning across planning perspectives, with
 *   consensus metrics and a side widened to include `no_trade`.
 */
export type PlanningAggregationResult = {
  side: "long" | "short" | "no_trade"
  thesis: string
  reasoning: string
  confidence_score: number
  confidence_breakdown: ConfidenceBreakdown
  leverage_suggested: number
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
