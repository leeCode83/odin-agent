/**
 * @file due-diligence/pipeline.ts
 * @description Thin pipeline wrapper that calls the DD Agent swarm for multi-factor due diligence.
 * @module due-diligence
 * @layer service
 */

import { getCategory } from "@/lib/asset-categories"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import type {
  DDPipelineInput,
  DDPipelineOutput,
  DDReport,
} from "@/lib/agent/types"

/**
 * @function runDDPipeline
 * @description Executes the full Due Diligence pipeline via the multi-agent swarm.
 * Imports the DD Agent run loop and manages top-level error handling and timing.
 * @param {DDPipelineInput} input - The input containing the asset and userId.
 * @returns {Promise<DDPipelineOutput>} The generated DD report and execution timings.
 * @throws {Error} When the asset is unknown or the pipeline fails fatally.
 */
export async function runDDPipeline(input: DDPipelineInput): Promise<DDPipelineOutput> {
  const t0 = Date.now()

  const category = getCategory(input.asset)
  if (!category) {
    throw new Error(`Unknown asset: ${input.asset}`)
  }

  try {
    const report = await runDDAgent({
      asset: input.asset,
      category,
      userId: input.userId ?? "anonymous",
      walletAddress: input.walletAddress,
    })

    return {
      report: report as DDReport,
      timing: {
        totalMs: Date.now() - t0,
        agentMs: report.processingTimeMs ?? Date.now() - t0,
      },
    }
  } catch (err) {
    throw new Error(`DD Pipeline failed for ${input.asset}: ${String(err)}`)
  }
}
