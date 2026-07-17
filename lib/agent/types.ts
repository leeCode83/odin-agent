import { z } from "zod"

/**
 * @constant SectionResultSchema
 * @description Zod schema for a single section's analysis result.
 */
export const SectionResultSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  summary: z.string().nullable(),
  signals: z.array(z.string()),
})

export const SECTION_KEYS = ["technical", "onchain", "sentiment", "fundamental"] as const

const SectionKey = z.enum(SECTION_KEYS)

/**
 * @constant DDReportSchema
 * @description Zod schema for the full Due Diligence report.
 */
export const DDReportSchema = z.object({
  asset: z.string(),
  category: z.string(),
  timestamp: z.string().datetime(),
  sections: z.record(SectionKey, SectionResultSchema),
  aggregated_thesis: z.string(),
  confidence_score: z.number().int().min(0).max(100),
  risk_flags: z.array(z.string()),
  errors: z.array(z.string()).optional(),
})

export type SectionResult = z.infer<typeof SectionResultSchema>
export type DDReport = z.infer<typeof DDReportSchema>
export type Factor = z.infer<typeof SectionKey>

export interface DDPipelineInput {
  asset: string
  userId: string
}

export interface DDPipelineOutput {
  report: DDReport
  timing: {
    fetchMs: number
    llmMs: number
    totalMs: number
  }
}

export const SideSchema = z.enum(["long", "short"])
export type Side = z.infer<typeof SideSchema>

export const AutonomyDecisionSchema = z.enum(["auto", "approve"])
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>

export const ConfidenceBreakdownSchema = z.object({
  factor_alignment: z.number().int().min(0).max(100),
  historical_match: z.number().int().min(0).max(100),
  signal_strength: z.number().int().min(0).max(100),
})
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdownSchema>

export const GraphPatternSchema = z.object({
  pattern: z.string(),
  outcome: z.string(),
  frequency: z.number().int().min(0),
})
export type GraphPattern = z.infer<typeof GraphPatternSchema>

export const RiskThresholdsSchema = z.object({
  confidence_threshold: z.number().int().min(0).max(100),
  max_position_usdc: z.number().min(0),
  max_leverage: z.number().min(1),
  risk_per_trade_percent: z.number().min(0).max(100),
})
export type RiskThresholds = z.infer<typeof RiskThresholdsSchema>

/**
 * @constant TradePlanSchema
 * @description Zod schema for the generated trade plan.
 */
export const TradePlanSchema = z.object({
  asset: z.string(),
  side: SideSchema,
  entry_price: z.number().positive(),
  position_size_usdc: z.number().min(0),
  position_size_contracts: z.number().min(0),
  stop_loss: z.number().positive(),
  take_profit: z.number().positive(),
  leverage: z.number().positive(),
  confidence_score: z.number().int().min(0).max(100),
  confidence_breakdown: ConfidenceBreakdownSchema,
  thesis: z.string(),
  reasoning: z.string(),
  autonomy_decision: AutonomyDecisionSchema,
  risk_flags: z.array(z.string()),
  graph_patterns_used: z.array(GraphPatternSchema),
  timestamp: z.string().datetime(),
})
export type TradePlan = z.infer<typeof TradePlanSchema>
