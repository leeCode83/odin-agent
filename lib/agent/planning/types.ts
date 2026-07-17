import { z } from "zod"
import type { DDReport, TradePlan, ConfidenceBreakdown } from "@/lib/agent/types"

export const PerspectiveSchema = z.enum(["conservative", "balance", "aggressive"])
export type Perspective = z.infer<typeof PerspectiveSchema>

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
export type PerspectiveResult = z.infer<typeof PerspectiveResultSchema>

export interface AggregatedReasoning {
  thesis: string
  confidence: ConfidenceBreakdown
  confidenceScore: number
  direction: "long" | "short"
  reasoning: string
}

export interface PlanningPipelineInput {
  ddReport: DDReport
  userId: string
  walletAddress: string
}

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
