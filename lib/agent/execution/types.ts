import type { TradePlan, DDReport } from "@/lib/agent/types"

export interface OrderBuildResult {
  entry: {
    oid?: number
    type: "entry"
    size: string
    price: string
    tif: "Ioc"
    side: "long" | "short"
  }
  takeProfit: {
    oid?: number
    type: "take_profit"
    triggerPrice: string
    size: string
    groupId: string
  }
  stopLoss: {
    oid?: number
    type: "stop_loss"
    triggerPrice: string
    size: string
    groupId: string
  }
}

export interface ExecutionResult {
  status: "placed" | "filled" | "partial" | "failed" | "cancelled"
  orders: Array<{
    type: "entry" | "take_profit" | "stop_loss"
    oid: number
    status: "open" | "filled" | "cancelled" | "rejected"
  }>
  groupId: string
  fillStatus: "pending" | "filled" | "partial" | "none"
  fillAmount: string | null
  fillPrice: string | null
  timestamp: string
  decisionKey?: string
}

export interface ExecutionPipelineInput {
  tradePlan: TradePlan
  walletAddress: string
  userId: string
  ddReport?: DDReport
}

export interface ExecutionPipelineOutput {
  execution: ExecutionResult
  timing: {
    buildMs: number
    placeMs: number
    graphMs: number
    totalMs: number
  }
}

export interface AgentInitResult {
  agentAddress: string
  agentPrivateKey: string
  approved: boolean
}

export interface OutcomeInput {
  decisionKey: string
  result: "profit" | "loss" | "breakeven" | "cancelled"
  pnlUsdc?: number
  pnlPercent?: number
  exitPrice?: number
  exitReason?: string
}
