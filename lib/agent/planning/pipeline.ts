/**
 * @file planning/pipeline.ts
 * @description Thin pipeline wrapper that calls the planning swarm agent
 *   (runPlanningAgent) and validates the returned TradePlan. Mirrors the DD
 *   pipeline structure (see lib/agent/due-diligence/pipeline.ts).
 * @module planning
 * @layer service
 */

import { runPlanningAgent } from "@/lib/agent/planning/agent"
import { TradePlanSchema } from "@/lib/agent/types"
import type { TradePlan } from "@/lib/agent/types"

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
 */
export interface PlanningPipelineResult {
  report: TradePlan
  timing: {
    totalMs: number
    agentMs: number
  }
  status: "complete" | "no_trade" | "partial" | "failed" | "approval_required"
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
 * @returns {Promise<PlanningPipelineResult>} The validated trade plan and execution timings.
 * @throws {PlanningError} When the agent fails or the plan fails validation.
 */
export async function runPlanningPipeline(input: {
  asset: string
  userId: string
  walletAddress: string
  targetProfitPercent?: number
}): Promise<PlanningPipelineResult> {
  const t0 = Date.now()
  const { asset, userId, walletAddress, targetProfitPercent = 100 } = input

  try {
    const { report, status } = await runPlanningAgent({
      asset,
      userId,
      walletAddress,
      targetProfitPercent,
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
