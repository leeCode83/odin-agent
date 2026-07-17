import { z } from "zod"
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
  confidence: z.number().int().min(0).max(100),
  side: z.enum(["long", "short"]),
  leverage: z.number().positive(),
  reasoning: z.string(),
  reasoningContent: z.string(),
  signals: z.array(z.string()),
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
  thesis: string
  confidence: ConfidenceBreakdown
  confidenceScore: number
  direction: "long" | "short"
  reasoning: string
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
  tradePlan: TradePlan
  timing: {
    equityMs: number
    candleMs: number
    graphMs: number
    llmMs: number
    riskMs: number
    totalMs: number
  }
}
