/**
 * @file due-diligence/types.ts
 * @description Type definitions for the DD Agent swarm — factor reports, agent state, plans.
 * @module due-diligence
 * @layer service
 */

import { z } from "zod"
import type { HistoryEntry } from "@/lib/agent/due-diligence/subagent"

/** @constant {readonly string[]} Known factor keys */
export const FACTOR_KEYS = ["technical", "onchain", "sentiment", "fundamental"] as const

/**
 * @typedef Factor
 * @description The four due-diligence factor types analyzed by the DD Agent.
 */
export type Factor = (typeof FACTOR_KEYS)[number]

/**
 * @interface SignalEntry
 * @description A single signal extracted from data analysis.
 */
export interface SignalEntry {
  name: string
  strength: number
  direction: "bullish" | "bearish" | "neutral"
}

/**
 * @typedef SubagentStopReason
 * @description Reason why a factor subagent completed its execution.
 */
export type SubagentStopReason = "llm_return" | "timeout" | "max_loops" | "circuit_open" | "duplicate" | "tool_budget"

/**
 * @interface FactorReport
 * @description Result from a single factor subagent analysis.
 */
export interface FactorReport {
  factor: Factor
  score: number | null
  confidence: number | null
  signals: SignalEntry[]
  dataSources: string[]
  reasoning: string
  iterations: number
  conclusion: string
  errors: string[]
  stopReason?: SubagentStopReason
  // reason: optional tool-call ledger from the ReAct loop — consumed by the
  // planning verifier for deterministic post-return validation. Optional so
  // DD consumers (aggregate/evaluate) and tests stay unchanged.
  toolHistory?: HistoryEntry[]
}

/**
 * @interface AgentRunState
 * @description Runtime state for the DD Agent swarm controller.
 */
export interface AgentRunState {
  runId: string
  asset: string
  status: string
  factorReports: Record<string, FactorReport | null>
  iteration: number
  errors: string[]
  startedAt: number
}

/**
 * @interface AgentPlan
 * @description Plan for deploying subagents.
 */
export interface AgentPlan {
  subagents: SubagentPlan[]
  reDeployHistory: ReDeployEntry[]
}

/**
 * @interface SubagentPlan
 * @description A single subagent deployment instruction.
 */
export interface SubagentPlan {
  factor: Factor
  instruction: string
  priority: number
}

/**
 * @interface ReDeployEntry
 * @description History entry tracking a subagent re-deployment.
 */
export interface ReDeployEntry {
  factor: Factor
  previousConfidence: number | null
  newInstruction: string
  iteration: number
}

/**
 * @interface CrossValidation
 * @description Cross-validation results comparing factor findings.
 */
export interface CrossValidation {
  pairs: ValidationPair[]
  overallAlignment: number
  contradictions: string[]
}

/**
 * @interface ValidationPair
 * @description Alignment score between two factor reports.
 */
export interface ValidationPair {
  factorA: Factor
  factorB: Factor
  alignment: number
  note: string
}

/**
 * @interface RiskEntry
 * @description A risk identified during due diligence.
 */
export interface RiskEntry {
  factor: Factor
  description: string
  severity: "low" | "medium" | "high"
}

/**
 * @interface CatalystEntry
 * @description A potential catalyst identified during due diligence.
 */
export interface CatalystEntry {
  factor: Factor
  description: string
  impact: "low" | "medium" | "high"
}

/**
 * @constant SignalEntrySchema
 * @description Zod schema for SignalEntry.
 */
export const SignalEntrySchema = z.object({
  name: z.string(),
  strength: z.number().min(0).max(100),
  direction: z.enum(["bullish", "bearish", "neutral"]),
})

/**
 * @constant FactorReportSchema
 * @description Zod schema for FactorReport.
 */
export const FactorReportSchema = z.object({
  factor: z.enum(FACTOR_KEYS),
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  signals: z.array(SignalEntrySchema),
  dataSources: z.array(z.string()),
  reasoning: z.string(),
  iterations: z.number().int().min(0),
  conclusion: z.string(),
  errors: z.array(z.string()),
  stopReason: z.enum(["llm_return", "timeout", "max_loops", "circuit_open", "duplicate", "tool_budget"]).optional(),
})

/**
 * @constant SubagentPlanSchema
 * @description Zod schema for SubagentPlan.
 */
export const SubagentPlanSchema = z.object({
  factor: z.enum(FACTOR_KEYS),
  instruction: z.string().min(1),
  priority: z.number().int().min(1).max(4),
})

/**
 * @interface AggregationResult
 * @description Result of the Main Agent's AGGREGATE step.
 */
export interface AggregationResult {
  thesis: string
  crossValidation: {
    pairs: Array<{ factorA: string; factorB: string; alignment: number; note: string }>
    overallAlignment: number
    contradictions: string[]
  }
  risks: Array<{ factor: string; description: string; severity: string }>
  catalysts: Array<{ factor: string; description: string; impact: string }>
  summary: string
}

/**
 * @constant ValidationPairSchema
 * @description Zod schema for ValidationPair.
 */
export const ValidationPairSchema = z.object({
  factorA: z.enum(FACTOR_KEYS),
  factorB: z.enum(FACTOR_KEYS),
  alignment: z.number().min(0).max(100),
  note: z.string(),
})

/**
 * @constant CrossValidationSchema
 * @description Zod schema for CrossValidation.
 */
export const CrossValidationSchema = z.object({
  pairs: z.array(ValidationPairSchema),
  overallAlignment: z.number().min(0).max(100),
  contradictions: z.array(z.string()),
})

/**
 * @constant RiskEntrySchema
 * @description Zod schema for RiskEntry.
 */
export const RiskEntrySchema = z.object({
  factor: z.enum(FACTOR_KEYS),
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]),
})

/**
 * @constant CatalystEntrySchema
 * @description Zod schema for CatalystEntry.
 */
export const CatalystEntrySchema = z.object({
  factor: z.enum(FACTOR_KEYS),
  description: z.string(),
  impact: z.enum(["low", "medium", "high"]),
})

/**
 * @constant AggregationResultSchema
 * @description Zod schema for AggregationResult.
 */
export const AggregationResultSchema = z.object({
  thesis: z.string(),
  crossValidation: CrossValidationSchema,
  risks: z.array(RiskEntrySchema),
  catalysts: z.array(CatalystEntrySchema),
  summary: z.string(),
})

/**
 * @class TransientToolError
 * @description Thrown when a tool call fails due to a temporary, retryable condition
 *   (e.g. network timeout, rate limit, upstream API flakiness).
 *   The ReAct loop MAY retry when this error is caught.
 */
export class TransientToolError extends Error {
  readonly name = "TransientToolError"
  constructor(message: string) {
    super(message)
  }
}

/**
 * @class PermanentToolError
 * @description Thrown when a tool call fails due to a non-recoverable condition
 *   (e.g. unknown tool name, invalid Zod-validated params, logic error).
 *   The ReAct loop MUST NOT retry when this error is caught.
 */
export class PermanentToolError extends Error {
  readonly name = "PermanentToolError"
  constructor(message: string) {
    super(message)
  }
}
