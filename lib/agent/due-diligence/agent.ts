/**
 * @file due-diligence/agent.ts
 * @description Main DDAgent orchestrator — coordinates the swarm of factor subagents
 *   in a Plan-Execute-Reflect loop with deterministic scoring and LLM aggregation.
 *   Fail-fast budgets: 3 max iterations, 120s per-factor timeout, and a global
 *   pipeline deadline (DD_PIPELINE_TIMEOUT_MS, default 5 min) checked at each
 *   iteration start; 2+ failed factors early-exit with a partial report.
 * @module due-diligence
 * @layer service
 */

import { runSubagent } from "@/lib/agent/due-diligence/subagent"
import { evaluateResults } from "@/lib/agent/due-diligence/evaluate"
import { think, plan, rePlan, aggregate } from "@/lib/agent/due-diligence/llm"
import { REACT_SYSTEM_PROMPT } from "@/lib/agent/due-diligence/prompts"
import { getToolRegistry } from "@/lib/agent/due-diligence/tools/registry"
import { fetchCandleMap } from "@/lib/agent/due-diligence/tools/technical/candles"
import { recordDDReport } from "@/lib/db/graph-memory"
import type { FactorReport, SubagentPlan, CrossValidation, AggregationResult } from "@/lib/agent/due-diligence/types"
import type { DDReport } from "@/lib/agent/types"
import { createDdLogger } from "@/lib/agent/due-diligence/logger"

const log = createDdLogger({ module: "agent" })

/**
 * @constant DEFAULT_MAX_LOOPS
 * @description Default Plan-Execute-Reflect cap per DD run (fail fast, was 5).
 */
const DEFAULT_MAX_LOOPS = 3

/**
 * @constant PER_FACTOR_TIMEOUT_MS
 * @description Wall-clock budget for one factor subagent run — its THINK phase
 *   must not exceed this; the subagent force-returns with collected data.
 */
const PER_FACTOR_TIMEOUT_MS = 120_000

/**
 * @constant DEFAULT_PIPELINE_TIMEOUT_MS
 * @description Global wall-clock budget for the whole DD pipeline before it
 *   returns a partial report (fail fast). Overridable via DD_PIPELINE_TIMEOUT_MS.
 */
const DEFAULT_PIPELINE_TIMEOUT_MS = 300_000

/**
 * @interface DDAgentParams
 * @description Parameters for a full DD Agent run.
 */
export interface DDAgentParams {
  /** Asset ticker or identifier (e.g. "BTC"). */
  asset: string
  /** Maximum Plan-Execute-Reflect iterations (default 3). */
  maxLoops?: number
  /** Global pipeline wall-clock budget in ms (default DD_PIPELINE_TIMEOUT_MS env or 300000). */
  pipelineTimeoutMs?: number
  /** Optional user ID for DB persistence. */
  userId?: string
  /** Optional wallet address for DB persistence. */
  walletAddress?: string
}

/**
 * @function computeDeterministicScore
 * @description Computes an overall score (weighted average of non-null scores by confidence) and overall
 *   confidence (minimum confidence among active reports).
 * @param {FactorReport[]} factorReports - Completed factor analyses.
 * @returns {{ overallScore: number; overallConfidence: number }} Aggregated deterministic scores.
 */
export function computeDeterministicScore(
  factorReports: FactorReport[]
): { overallScore: number; overallConfidence: number } {
  const active = factorReports.filter((r) => r.score !== null)
  if (active.length === 0) return { overallScore: 0, overallConfidence: 0 }

  const totalWeight = active.reduce((sum, r) => sum + (r.confidence ?? 0), 0)
  
  const overallScore = totalWeight === 0 ? 0 
    : Math.round(
        active.reduce((sum, r) => sum + (r.score ?? 0) * (r.confidence ?? 0), 0) / totalWeight
      )

  const overallConfidence = Math.min(...active.map(r => r.confidence ?? 0))

  return { overallScore, overallConfidence }
}

/**
 * @function buildFinalReport
 * @description Assembles the complete DDReport from factor reports, LLM aggregation,
 *   deterministic scoring, and run metadata.
 * @param {object} params - Report assembly parameters.
 * @param {string} params.asset - Asset ticker.
 * @param {FactorReport[]} params.factorReports - All collected factor reports.
 * @param {any} params.aggregation - LLM aggregation result (null on failure).
 * @param {{ overallScore: number; overallConfidence: number }} params.deterministic - Deterministic scores.
 * @param {number} params.iterations - Number of iterations completed.
 * @param {number} params.processingTimeMs - Total processing wall-clock time.
 * @param {"complete" | "partial" | "failed"} params.status - Final run status.
 * @param {string[]} params.errors - Errors encountered during the run.
 * @returns {DDReport} The assembled due diligence report.
 * @description usableFactorCount counts factorReports with a non-null score:
 *   a failed factor subagent yields score null and is NOT usable, while a
 *   genuine 0 confidence score from a successful run IS usable.
 */
export function buildFinalReport(params: {
  asset: string
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
    category: "",
    timestamp: new Date().toISOString(),
    sections: sections as DDReport["sections"],
    factorReports: params.factorReports,
    // reason: usable = non-null score; failed factors (null) are excluded,
    // genuine 0 scores from successful runs count as usable signals.
    usableFactorCount: params.factorReports.filter((fr) => fr.score !== null).length,
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
 *   Plan-Execute-Reflect loop for up to `maxLoops` iterations (default 3):
 *   1. PLAN — determines which subagents to deploy and their instructions.
 *   2. EXECUTE — deploys subagents in parallel (each bounded by the 120s
 *      per-factor timeout).
 *   3. AGGREGATE — merges factor reports via LLM.
 *   4. EVALUATE — decides whether to ACCEPT, RE-DEPLOY, or fail.
 *   On RE-DEPLOY, re-plans for low-confidence factors and loops.
 *   Fail fast: the pipeline deadline (default 300s) is checked at each
 *   iteration start and aborts with a partial report; 2+ failed factors
 *   after an iteration early-exit without further re-deploys.
 *   Optionally persists the final report to the graph database.
 *
 * @param {DDAgentParams} params - Agent configuration.
 * @returns {Promise<DDReport>} The final due diligence report.
 */
export async function runDDAgent(params: DDAgentParams): Promise<DDReport> {
  const t0 = Date.now()
  const maxLoops = params.maxLoops ?? DEFAULT_MAX_LOOPS
  const pipelineTimeoutMs =
    params.pipelineTimeoutMs ?? (Number(process.env.DD_PIPELINE_TIMEOUT_MS) || DEFAULT_PIPELINE_TIMEOUT_MS)
  const errors: string[] = []
  let allFactorReports: FactorReport[] = []
  let aggregation: AggregationResult | null = null
  let status: "complete" | "partial" | "failed" = "failed"
  let planSteps: SubagentPlan[] = []

  // --- PLAN ---
  try {
    planSteps = await plan({
      asset: params.asset,
    })
  } catch (e) {
    errors.push(`Initial plan failed: ${String(e)}`)
    planSteps = (["technical", "onchain", "sentiment", "fundamental"] as const).map((f) => ({
      factor: f,
      instruction: `Analyze ${f} for ${params.asset}`,
      priority: 1,
    }))
  }

  // --- Pre-fetch candle map for technical subagent ---
  const candleMap = await fetchCandleMap(params.asset).catch(() => undefined)

  // --- EXECUTE-REFLECT LOOP ---
  for (let iteration = 0; iteration < maxLoops; iteration++) {
    // reason: fail fast — stop deploying new iterations once the pipeline
    // budget is exhausted and return whatever was collected so far.
    if (Date.now() - t0 > pipelineTimeoutMs) {
      errors.push(`Pipeline timeout exceeded after ${iteration} iteration(s)`)
      return buildFinalReport({
        asset: params.asset,
        factorReports: allFactorReports,
        aggregation,
        deterministic: computeDeterministicScore(allFactorReports),
        iterations: iteration,
        processingTimeMs: Date.now() - t0,
        status: "partial",
        errors,
      })
    }

    // EXECUTE — deploy subagents in parallel, each bounded by its own
    // wall-clock budget so one slow factor cannot stall the pipeline.
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
          timeoutMs: PER_FACTOR_TIMEOUT_MS,
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
        ).catch((e) => log("warn", "db_persist_failed", { error: e instanceof Error ? e.message : String(e) }))
      }

      return report
    }

    if (evaluation.decision === "PARTIAL") {
      status = "partial"
      const report = buildFinalReport({
        asset: params.asset,
        factorReports: allFactorReports,
        aggregation,
        deterministic,
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status,
        errors,
      })

      if (params.userId && params.walletAddress) {
        recordDDReport(
          report as unknown as Record<string, unknown>,
          params.userId,
          params.walletAddress
        ).catch((e) => log("warn", "db_persist_failed", { error: e instanceof Error ? e.message : String(e) }))
      }

      return report
    }

    if (evaluation.decision === "FAILED") {
      status = "failed"
      return buildFinalReport({
        asset: params.asset,
        factorReports: allFactorReports,
        aggregation,
        deterministic,
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status,
        errors,
      })
    }

    // RE-DEPLOY — but fail fast: with 2+ factors already failed, re-deploying
    // the survivors cannot rescue the report; return the partial immediately
    // (usableFactorCount still computed by buildFinalReport, so the planning
    // quality gate keeps its Phase 2 behavior).
    const failedFactorCount = allFactorReports.filter((r) => r.score === null).length
    if (failedFactorCount >= 2) {
      errors.push(`Early exit — ${failedFactorCount} factors failed; partial report returned`)
      return buildFinalReport({
        asset: params.asset,
        factorReports: allFactorReports,
        aggregation,
        deterministic: computeDeterministicScore(allFactorReports),
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status: "partial",
        errors,
      })
    }

    // RE-DEPLOY — cap at 1 re-deploy round. reason: market data is unchanged
    // between iterations, so a second re-deploy re-runs the same analysis on
    // the same data; returning partial is the honest outcome and avoids the
    // 3-iteration runtime blow-up (3.4min observed).
    if (iteration >= 1) {
      errors.push("Re-deploy budget exhausted (max 1 round); partial report returned")
      return buildFinalReport({
        asset: params.asset,
        factorReports: allFactorReports,
        aggregation,
        deterministic: computeDeterministicScore(allFactorReports),
        iterations: iteration + 1,
        processingTimeMs: Date.now() - t0,
        status: "partial",
        errors,
      })
    }

    // RE-DEPLOY — generate new plan for low-confidence factors
    if (iteration < maxLoops - 1) {
      try {
        planSteps = await rePlan({
          asset: params.asset,
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
    factorReports: allFactorReports,
    aggregation,
    deterministic: computeDeterministicScore(allFactorReports),
    iterations: maxLoops,
    processingTimeMs: Date.now() - t0,
    status: "partial",
    errors: [...errors, "Exhausted max loops without accepting"],
  })
}
