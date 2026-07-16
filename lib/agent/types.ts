import { z } from "zod"

export const SectionResultSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  summary: z.string().nullable(),
  signals: z.array(z.string()),
})

export const SECTION_KEYS = ["technical", "onchain", "sentiment", "fundamental"] as const

const SectionKey = z.enum(SECTION_KEYS)

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
