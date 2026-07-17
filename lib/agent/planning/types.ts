import { z } from "zod"
import { ConfidenceBreakdownSchema } from "@/lib/agent/types"
import type { DDReport, TradePlan, ConfidenceBreakdown } from "@/lib/agent/types"

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
 * @constant PerspectiveResultSchema
 * @description Zod schema for the result of a single LLM perspective analysis.
 */
export const PerspectiveResultSchema = z.object({
  perspective: PerspectiveSchema,
  thesis: z.string(),
  confidence_breakdown: ConfidenceBreakdownSchema,
  side: z.enum(["long", "short"]),
  leverage_suggested: z.number().positive(),
  reasoning: z.string(),
  reasoningContent: z.string(),
  risk_flags: z.array(z.string()),
})

/**
 * @type PerspectiveResult
 * @description Inferred type for the perspective result.
 */
export type PerspectiveResult = z.infer<typeof PerspectiveResultSchema>

/**
 * @interface AggregatedReasoning
 * @description Structure for the synthesized trade thesis from multiple perspectives.
 */
export interface AggregatedReasoning {
  side: "long" | "short"
  thesis: string
  reasoning: string
  confidence_score: number
  confidence_breakdown: ConfidenceBreakdown
  leverage_suggested: number
  risk_flags: string[]
}

/**
 * @interface PlanningPipelineInput
 * @description Input parameters for the trade planning pipeline.
 */
export interface PlanningPipelineInput {
  ddReport: DDReport
  userId: string
  walletAddress: string
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
