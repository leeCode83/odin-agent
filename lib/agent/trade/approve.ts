import { runExecutionPipeline } from "@/lib/agent/execution/pipeline"
import type { ApproveInput } from "./types"

export async function approveTradePlan(input: ApproveInput) {
  const { tradePlan, walletAddress, userId, ddReport } = input

  const output = await runExecutionPipeline({
    tradePlan: { ...tradePlan, autonomy_decision: "auto" },
    walletAddress,
    userId,
    ddReport,
  })

  return output
}
