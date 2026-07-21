import type { DDReport, TradePlan } from "@/lib/agent/types"
import type { ExecutionResult } from "@/lib/agent/execution/types"

export interface TradePipelineInput {
  asset: string
  userId: string
  walletAddress: string
}

export type TradePipelineStatus = "executed" | "requires_approval"

export interface TradePipelineOutput {
  status: TradePipelineStatus
  ddReport: DDReport
  tradePlan: TradePlan
  execution?: ExecutionResult
  timing: {
    ddMs: number
    planningMs: number
    executionMs: number
    totalMs: number
  }
}

export interface ApproveInput {
  tradePlan: TradePlan
  walletAddress: string
  userId: string
  ddReport?: DDReport
}

export interface RejectInput {
  tradePlan: TradePlan
  userId: string
  reason?: string
}
