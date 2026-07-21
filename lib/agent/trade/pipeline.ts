import { runDDPipeline } from "@/lib/agent/due-diligence/pipeline"
import { runPlanningPipeline } from "@/lib/agent/planning/pipeline"
import { runExecutionPipeline } from "@/lib/agent/execution/pipeline"
import type { TradePipelineInput, TradePipelineOutput } from "./types"

export class TradeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TradeError"
  }
}

export async function runTradePipeline(
  input: TradePipelineInput
): Promise<TradePipelineOutput> {
  const t0 = Date.now()
  const { asset, userId, walletAddress } = input

  const ddOutput = await runDDPipeline({ asset, userId })
  const ddMs = Date.now() - t0
  const ddReport = ddOutput.report

  const planningOutput = await runPlanningPipeline({ ddReport, userId, walletAddress })
  const planningMs = Date.now() - t0 - ddMs
  const tradePlan = planningOutput.plan

  if (tradePlan.autonomy_decision === "approve") {
    return {
      status: "requires_approval",
      ddReport,
      tradePlan,
      timing: {
        ddMs,
        planningMs,
        executionMs: 0,
        totalMs: Date.now() - t0,
      },
    }
  }

  const executionOutput = await runExecutionPipeline({
    tradePlan,
    walletAddress,
    userId,
    ddReport,
  })
  const executionMs = Date.now() - t0 - ddMs - planningMs

  return {
    status: "executed",
    ddReport,
    tradePlan,
    execution: executionOutput.execution,
    timing: {
      ddMs,
      planningMs,
      executionMs,
      totalMs: Date.now() - t0,
    },
  }
}
