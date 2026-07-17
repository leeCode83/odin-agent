import { z } from "zod"

export interface DecisionNode {
  _key?: string
  userId: string
  asset: string
  category: string
  decision: "buy" | "sell" | "hold"
  side: "long" | "short"
  confidence: number
  tradePlan: unknown
  autonomyDecision: "auto" | "approve"
  timestamp: string
}

export interface SignalNode {
  _key?: string
  factor: string
  signalType: string
  description: string
  strength: number
  timestamp: string
}

export interface OutcomeNode {
  _key?: string
  result: "profit" | "loss" | "breakeven" | "cancelled"
  pnlUsdc?: number
  pnlPercent?: number
  exitPrice?: number
  exitReason?: string
  timestamp: string
}

export interface AssetNode {
  _key: string
  name: string
  category: string
}

export const RiskThresholdsDocSchema = z.object({
  _key: z.string().optional(),
  userId: z.string(),
  confidenceThreshold: z.number().int().min(0).max(100).default(70),
  maxPositionUsdc: z.number().min(0).default(100),
  maxLeverage: z.number().min(1).default(10),
  riskPerTradePercent: z.number().min(0).max(100).default(1),
})
export type RiskThresholdsDoc = z.infer<typeof RiskThresholdsDocSchema>

export interface GraphMemoryEdge {
  _from: string
  _to: string
  collection: string
  weight?: number
  timestamp?: string
}

export const GraphCollectionNames = {
  DECISIONS: "decisions",
  SIGNALS: "signals",
  OUTCOMES: "outcomes",
  ASSETS: "assets",
  EDGE_DECISION_ANALYZED: "decision_analyzed",
  EDGE_DECISION_TRIGGERED_BY: "decision_triggered_by",
  EDGE_DECISION_RESULTED_IN: "decision_resulted_in",
  EDGE_ASSET_BELONGS_TO: "asset_belongs_to",
} as const
