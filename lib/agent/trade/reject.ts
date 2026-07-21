import { recordGraphMemory, recordOutcome } from "@/lib/db/graph-memory"
import type { RejectInput } from "./types"

export class RejectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RejectError"
  }
}

export async function rejectTradePlan(input: RejectInput) {
  const { tradePlan, userId, reason } = input

  const decisionKey = await recordGraphMemory({
    userId,
    asset: tradePlan.asset,
    tradePlan,
    signals: [],
  })

  await recordOutcome(decisionKey, {
    result: "cancelled",
    exitReason: reason ?? "manual_reject",
  })

  return { decisionKey }
}
