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
 * @class PlanningError
 * @description Custom error class for errors occurring during the planning
 *   pipeline. Carries optional structured detail (spec §9.6 error response
 *   shape: phase, reports, aggregation, ddReport) and the wall-clock time of
 *   the failed run, so the route layer can surface them to the client.
 */
export class PlanningError extends Error {
  detail?: Record<string, unknown>
  processingTimeMs?: number

  constructor(message: string, detail?: Record<string, unknown>, processingTimeMs?: number) {
    super(message)
    this.name = "PlanningError"
    this.detail = detail
    this.processingTimeMs = processingTimeMs
  }
}

/**
 * @interface PlanningPipelineResult
 * @description Output of the planning pipeline: the validated trade plan and
 *   execution timings.
 */
export interface PlanningPipelineResult {
  report: TradePlan
  timing: {
    totalMs: number
    agentMs: number
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
    const { report } = await runPlanningAgent({
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
    }
  } catch (err) {
    // reason: carry over structured detail/processingTimeMs from an already
    // wrapped PlanningError so the route layer (spec §9.6) can surface them.
    if (err instanceof PlanningError) {
      throw new PlanningError(
        `Planning pipeline failed for ${asset}: ${err.message}`,
        err.detail,
        err.processingTimeMs
      )
    }
    throw new PlanningError(`Planning pipeline failed for ${asset}: ${String(err)}`)
  }
}
