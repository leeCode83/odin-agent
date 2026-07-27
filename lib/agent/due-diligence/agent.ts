/**
 * @file due-diligence/agent.ts
 * @description Main DDAgent orchestrator — coordinates the swarm of factor subagents
 *   in a Plan-Execute-Reflect loop with deterministic scoring and LLM aggregation.
 * @module due-diligence
 * @layer service
 */

import { runSubagent } from "@/lib/agent/due-diligence/subagent"
import { evaluateResults } from "@/lib/agent/due-diligence/evaluate"
import { think, plan, rePlan, aggregate } from "@/lib/agent/due-diligence/llm"
import { REACT_SYSTEM_PROMPT } from "@/lib/agent/due-diligence/prompts"
import { getToolRegistry } from "@/lib/agent/tools/registry"
import { fetchCandleMap } from "@/lib/agent/tools/technical/candles"
import { recordDDReport } from "@/lib/db/graph-memory"
import type { FactorReport, SubagentPlan, CrossValidation } from "@/lib/agent/due-diligence/types"
import type { DDReport } from "@/lib/agent/types"

interface AggregationResult {
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
 * @interface DDAgentParams
 * @description Parameters for a full DD Agent run.
 */
export interface DDAgentParams {
  /** Asset ticker or identifier (e.g. "BTC"). */
  asset: string
  /** Category configuration with name and active factor list. */
  category: { name: string; activeFactors: string[] }
  /** Maximum Plan-Execute-Reflect iterations (default 5). */
  maxLoops?: number
  /** Optional user ID for DB persistence. */
  userId?: string
  /** Optional wallet address for DB persistence. */
  walletAddress?: string
}

/**
 * @function computeDeterministicScore
 * @description Computes an overall score (average of non-null scores) and overall
 *   confidence (minimum confidence among active reports).
 * @param {FactorReport[]} factorReports - Completed factor analyses.
 * @returns {{ overallScore: number; overallConfidence: number }} Aggregated deterministic scores.
 */
export function computeDeterministicScore(
  factorReports: FactorReport[]
): { overallScore: number; overallConfidence: number } {
  const active = factorReports.filter((r) => r.score !== null)
  if (active.length === 0) return { overallScore: 0, overallConfidence: 0 }

  const overallScore = Math.round(
    active.reduce((sum, r) => sum + (r.score ?? 0), 0) / active.length
  )
  const overallConfidence = Math.round(
    active.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / active.length
  )

  return { overallScore, overallConfidence }
}

/**
 * @function buildFinalReport
 * @description Assembles the complete DDReport from factor reports, LLM aggregation,
 *   deterministic scoring, and run metadata.
 * @param {object} params - Report assembly parameters.
 * @param {string} params.asset - Asset ticker.
 * @param {string} params.category - Asset category name.
 * @param {FactorReport[]} params.factorReports - All collected factor reports.
 * @param {any} params.aggregation - LLM aggregation result (null on failure).
 * @param {{ overallScore: number; overallConfidence: number }} params.deterministic - Deterministic scores.
 * @param {number} params.iterations - Number of iterations completed.
 * @param {number} params.processingTimeMs - Total processing wall-clock time.
 * @param {"complete" | "partial" | "failed"} params.status - Final run status.
 * @param {string[]} params.errors - Errors encountered during the run.
 * @returns {DDReport} The assembled due diligence report.
 */
export function buildFinalReport(params: {
  asset: string
  category: string
  factorReports: FactorReport[]
  aggregation: AggregationResult | null
  deterministic: { overallScore: number; overallConfidence: number }
  iterations: number
  processingTimeMs: number
  status: "complete" | "partial" | "failed"
  errors: string[]
}): DDReport {
  const sections: Record<string, { score: number | null; summary: string | null; signals: string[] }> = {}
  for (const fr of params.factorReports) {
    const key = fr.factor
    sections[key] = {
      score: fr.score,
      summary: fr.conclusion,
      signals: fr.signals.map((s) => s.name),
    }
  }

  return {
    asset: params.asset,
    category: params.category,
    timestamp: new Date().toISOString(),
    sections: sections as DDReport["sections"],
    factorReports: params.factorReports,
    overallScore: params.deterministic.overallScore,
    overallConfidence: params.deterministic.overallConfidence,
    crossValidation: (params.aggregation?.crossValidation ?? {
      pairs: [],
      overallAlignment: 0,
      contradictions: [],
    }) as CrossValidation,
    risks: (params.aggregation?.risks ?? []) as unknown as DDReport["risks"],
    catalysts: (params.aggregation?.catalysts ?? []) as unknown as DDReport["catalysts"],
    summary: params.aggregation?.summary ?? "",
    aggregated_thesis: params.aggregation?.thesis ?? "",
    confidence_score: params.deterministic.overallConfidence,
    iterations: params.iterations,
    status: params.status,
    processingTimeMs: params.processingTimeMs,
    risk_flags:
      params.aggregation?.risks?.map((r) => r.description) ?? [],
    errors: params.errors.length > 0 ? params.errors : undefined,
  }
}

/**
 * @function runDDAgent
 * @description Main orchestrator for the due diligence swarm agent. Runs a
 *   Plan-Execute-Reflect loop for up to `maxLoops` iterations:
 *   1. PLAN — determines which subagents to deploy and their instructions.
 *   2. EXECUTE — deploys subagents in parallel.
 *   3. AGGREGATE — merges factor reports via LLM.
 *   4. EVALUATE — decides whether to ACCEPT, RE-DEPLOY, or fail.
 *   On RE-DEPLOY, re-plans for low-confidence factors and loops.
 *   Optionally persists the final report to the graph database.
 *
 * @param {DDAgentParams} params - Agent configuration.
 * @returns {Promise<DDReport>} The final due diligence report.
 */
export async function runDDAgent(params: DDAgentParams): Promise<DDReport> {
  const t0 = Date.now()
  const maxLoops = params.maxLoops ?? 5
  const errors: string[] = []
  let allFactorReports: FactorReport[] = []
  let aggregation: AggregationResult | null = null
  let status: "complete" | "partial" | "failed" = "failed"
  let planSteps: SubagentPlan[] = []

  // --- PLAN ---
  try {
    planSteps = await plan({
      asset: params.asset,
      category: params.category,
    })
  } catch (e) {
    errors.push(`Initial plan failed: ${String(e)}`)
    planSteps = params.category.activeFactors.map((f) => ({
      factor: f as SubagentPlan["factor"],
      instruction: `Analyze ${f} for ${params.asset}`,
      priority: 1,
    }))
  }

  // --- Pre-fetch candle map for technical subagent ---
  const candleMap = await fetchCandleMap(params.asset).catch(() => undefined)

  // --- EXECUTE-REFLECT LOOP ---
  for (let iteration = 0; iteration < maxLoops; iteration++) {
    // EXECUTE — deploy subagents in parallel
    const subagentResults = await Promise.all(
      planSteps.map(async (subagentPlan) => {
        const tools = getToolRegistry(subagentPlan.factor, { candleMap })
        return runSubagent({
          factor: subagentPlan.factor,
          tools,
          instruction: subagentPlan.instruction,
          asset: params.asset,
          llmThink: think,
          getSystemPrompt: REACT_SYSTEM_PROMPT,
        })
      })
    )

    // ponytail: Map dedupe by factor — latest report per factor wins
    allFactorReports = Array.from(
      new Map([...allFactorReports, ...subagentResults].map((r) => [r.factor, r])).values()
    )

    // AGGREGATE
    aggregation = await aggregate({
      asset: params.asset,
      category: params.category.name,
      factorReports: allFactorReports,
    })
    if (!aggregation) {
      errors.push("Aggregation step returned null — cross-factor analysis unavailable")
    }

    const deterministic = computeDeterministicScore(allFactorReports)

    // EVALUATE
    const evaluation = evaluateResults(allFactorReports, aggregation?.crossValidation as CrossValidation | undefined)

    if (evaluation.decision === "ACCEPT") {
      status = aggregation ? "complete" : "partial"
      const report = buildFinalReport({
        asset: params.asset,
        category: params.category.name,
        factorReports: allFactorReports,
        aggregation,
        deterministic,
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status,
        errors,
      })

      // Non-blocking DB persistence
      if (params.userId && params.walletAddress) {
        recordDDReport(
          report as unknown as Record<string, unknown>,
          params.userId,
          params.walletAddress
        ).catch((e) => console.warn("[DDAgent] Failed to persist DD report:", e))
      }

      return report
    }

    if (evaluation.decision === "PARTIAL" || evaluation.decision === "FAILED") {
      status = evaluation.decision === "FAILED" ? "failed" : "partial"
      return buildFinalReport({
        asset: params.asset,
        category: params.category.name,
        factorReports: allFactorReports,
        aggregation,
        deterministic,
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status,
        errors,
      })
    }

    // RE-DEPLOY — generate new plan for low-confidence factors
    if (iteration < maxLoops - 1) {
      try {
        planSteps = await rePlan({
          asset: params.asset,
          category: params.category.name,
          lowConfidenceFactors: evaluation.lowConfidenceFactors,
          previousReports: allFactorReports.filter((r) =>
            evaluation.lowConfidenceFactors.includes(r.factor)
          ),
        })
      } catch (e) {
        errors.push(`Re-plan failed: ${String(e)}`)
        planSteps = evaluation.lowConfidenceFactors.map((f) => ({
          factor: f as SubagentPlan["factor"],
          instruction: `Re-analyze ${f} for ${params.asset} with higher scrutiny`,
          priority: 1,
        }))
      }
    }
  }

  // Exhausted max loops without accepting
  return buildFinalReport({
    asset: params.asset,
    category: params.category.name,
    factorReports: allFactorReports,
    aggregation,
    deterministic: computeDeterministicScore(allFactorReports),
    iterations: maxLoops,
    processingTimeMs: Date.now() - t0,
    status: "partial",
    errors: [...errors, "Exhausted max loops without accepting"],
  })
}
