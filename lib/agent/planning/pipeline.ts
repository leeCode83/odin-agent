/**
 * @file planning/pipeline.ts
 * @description Thin pipeline wrapper that calls the planning swarm agent
 *   (runPlanningAgent) and validates the returned TradePlan. Mirrors the DD
 *   pipeline structure (see lib/agent/due-diligence/pipeline.ts).
 * @module planning
 * @layer service
 */

import { runPlanningAgent } from "@/lib/agent/planning/agent"
import { log } from "@/lib/agent/planning/log"
import type { DDCoverage } from "@/lib/agent/planning/types"
import { TradePlanSchema } from "@/lib/agent/types"
import type { TradePlan, DDReport } from "@/lib/agent/types"
import { extractDegradedFactors } from "@/lib/agent/shared/dd-utils"

/**
 * @type PlanningErrorCategory
 * @description Error taxonomy for planning failures (spec §9.6 extension):
 *   - "dd"       — the DD report itself is unusable (status failed, zero
 *                  usable factors, or the DD agent threw before producing one).
 *   - "llm"      — LLM-layer failures (DeepSeek API 401/429/5xx, JSON parse
 *                  failures of LLM output, empty responses).
 *   - "data"     — upstream provider failures (market data fetches: candles,
 *                  equity, other external data sources the pipeline calls).
 *   - "internal" — anything else: unexpected bugs, schema validation failures
 *                  of our own plan shape, consensus collapse (phase "evaluate").
 *   Route mapping (see app/api/agent/planning/route.ts): dd → 422, llm → 422,
 *   data → 502, internal → 500; circuit-breaker tripped → 503.
 */
export type PlanningErrorCategory = "dd" | "llm" | "data" | "internal"

/**
 * @class PlanningError
 * @description Custom error class for errors occurring during the planning
 *   pipeline. Carries optional structured detail (spec §9.6 error response
 *   shape: phase, reports, aggregation, ddReport), the wall-clock time of
 *   the failed run, and an error category from the taxonomy above, so the
 *   route layer can map them to HTTP codes.
 */
export class PlanningError extends Error {
  detail?: Record<string, unknown>
  processingTimeMs?: number
  errorCategory: PlanningErrorCategory

  constructor(
    message: string,
    detail?: Record<string, unknown>,
    processingTimeMs?: number,
    errorCategory: PlanningErrorCategory = "internal"
  ) {
    super(message)
    this.name = "PlanningError"
    this.detail = detail
    this.processingTimeMs = processingTimeMs
    this.errorCategory = errorCategory
  }
}

/**
 * @interface PlanningPipelineResult
 * @description Output of the planning pipeline: the validated trade plan,
 *   execution timings, and the agent-level run status (complete / no_trade /
 *   partial / approval_required) so the route layer can surface it.
 *   `ddCoverage` is present only when the upstream DD report was partial —
 *   omitted entirely (key absent) when every factor scored.
 */
export interface PlanningPipelineResult {
  report: TradePlan
  timing: {
    totalMs: number
    agentMs: number
  }
  status: "complete" | "no_trade" | "partial" | "failed" | "approval_required"
  // reason: degraded-DD signaling (F3) — see DDCoverage; used by the route
  // layer to tell consumers the plan was made on incomplete analysis.
  ddCoverage?: DDCoverage
}

/**
 * @function computeDDCoverage
 * @description Derives the DD coverage summary from the report's factor
 *   reports: total factor count, usable (scored) count, and the names of
 *   failed factors (score null or missing). Returns undefined when nothing
 *   failed, so the output key is omitted rather than present-but-empty.
 * @param {DDReport} ddReport - The upstream due diligence report.
 * @returns {DDCoverage | undefined} Coverage summary, or undefined when all factors scored.
 */
function computeDDCoverage(ddReport: DDReport): DDCoverage | undefined {
  // reason: factorReports is optional on DDReportSchema — a report without
  // them has zero failed factors and stays non-degraded.
  const factorReports = ddReport.factorReports ?? []
  const failedFactors = extractDegradedFactors(factorReports)
  if (failedFactors.length === 0) return undefined
  return {
    usableFactorCount: factorReports.filter((f) => typeof f.score === "number").length,
    totalFactors: factorReports.length,
    failedFactors,
  }
}

/**
 * @function runPlanningPipeline
 * @description Executes the full planning pipeline: calls the planning swarm
 *   agent (Plan-Execute-Reflect loop) and validates its TradePlan.
 * @param {object} input - Pipeline input.
 * @param {string} input.asset - Asset ticker.
 * @param {string} input.userId - User identifier.
 * @param {string} input.walletAddress - User's wallet address.
 * @param {number} [input.targetProfitPercent] - Target profit percent; defaults to 100.
 * @param {DDReport} input.ddReport - The due diligence report to base the plan on.
 * @returns {Promise<PlanningPipelineResult>} The validated trade plan and execution timings.
 *   Includes `ddCoverage` when the DD report was partial (some factors failed).
 * @throws {PlanningError} When the agent fails or the plan fails validation.
 */
export async function runPlanningPipeline(input: {
  asset: string
  userId: string
  walletAddress: string
  targetProfitPercent?: number
  ddReport: DDReport
}): Promise<PlanningPipelineResult> {
  const t0 = Date.now()
  const { asset, userId, walletAddress, targetProfitPercent = 100, ddReport } = input

  try {
    // reason: coverage is derived before the agent call so degraded input is
    // signaled even if the swarm itself later throws (the error path re-throws
    // without it, but the log line below records the degraded input).
    const ddCoverage = computeDDCoverage(ddReport)
    if (ddCoverage) {
      log("info", "planning.degraded_dd", { failedFactors: ddCoverage.failedFactors })
    }

    const { report, status } = await runPlanningAgent({
      asset,
      userId,
      walletAddress,
      targetProfitPercent,
      ddReport,
    })

    return {
      report: TradePlanSchema.parse(report),
      timing: {
        totalMs: Date.now() - t0,
        // reason: agentMs prefers the agent-reported wall time; falls back to
        // the pipeline wall time when the plan carries no processingTimeMs.
        agentMs: report.processingTimeMs ?? Date.now() - t0,
      },
      status,
      // reason: spread keeps the key ABSENT (not undefined) when not degraded —
      // contract F3: "omit the field entirely when nothing failed".
      ...(ddCoverage ? { ddCoverage } : {}),
    }
  } catch (err) {
    // reason: carry over structured detail/processingTimeMs/errorCategory from
    // an already wrapped PlanningError so the route layer (spec §9.6) can
    // surface them and map the category to an HTTP code.
    if (err instanceof PlanningError) {
      throw new PlanningError(
        `Planning pipeline failed for ${asset}: ${err.message}`,
        err.detail,
        err.processingTimeMs,
        err.errorCategory
      )
    }
    // reason: raw non-PlanningError escape — classify as internal (unexpected
    // bug / validation failure); LLM and data errors are wrapped by their own
    // layers before reaching here.
    throw new PlanningError(`Planning pipeline failed for ${asset}: ${String(err)}`)
  }
}
