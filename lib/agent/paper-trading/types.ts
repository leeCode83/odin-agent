/**
 * @file lib/agent/paper-trading/types.ts
 * @description Type definitions and Zod schemas for the paper trading feature.
 *   Covers duration options, trade lifecycle status, input validation,
 *   persistent trade records, price snapshots, and cross-detection results.
 * @module paper-trading-types
 * @layer agent
 */

import { z } from "zod"

/**
 * Supported monitoring durations for paper trades.
 * After this duration, the paper trade auto-closes with the current price.
 */
export const DurationSchema = z.enum(["1h", "5h", "24h", "3d", "7d"])

/** Inferred duration union type from DurationSchema. */
export type Duration = z.infer<typeof DurationSchema>

/** Maps duration enum to milliseconds. */
export const DURATION_MS: Record<Duration, number> = {
  "1h": 60 * 60 * 1000,
  "5h": 5 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
}

/**
 * Paper trade lifecycle status.
 * - `active`: monitoring in progress
 * - `tp_hit`: take-profit price crossed
 * - `sl_hit`: stop-loss price crossed
 * - `expired`: duration elapsed without TP/SL hit
 * - `cancelled`: user or system cancelled
 * - `no_trade`: planning agent decided not to trade
 */
export const PaperTradeStatusSchema = z.enum([
  "active",
  "tp_hit",
  "sl_hit",
  "expired",
  "cancelled",
  "no_trade",
])
/** Inferred paper trade status union type from PaperTradeStatusSchema. */
export type PaperTradeStatus = z.infer<typeof PaperTradeStatusSchema>

/**
 * Input to create a paper trade.
 * `planReport` is optional — if omitted, the route runs DD + Planning agents.
 */
export const PaperTradeInputSchema = z.object({
  asset: z.string().min(1),
  userId: z.string().min(1),
  walletAddress: z.string().min(1),
  targetProfitPercent: z.number().positive().optional(),
  duration: DurationSchema,
  planReport: z.unknown().optional(),
})
/** Inferred paper trade input type from PaperTradeInputSchema. */
export type PaperTradeInput = z.infer<typeof PaperTradeInputSchema>

/**
 * Persistent paper trade record stored in ArangoDB `paper_trades` collection.
 */
export interface PaperTrade {
  _key?: string
  userId: string
  walletAddress: string
  asset: string
  side: "long" | "short" | "no_trade"
  entryPrice: number
  stopLoss: number
  takeProfit: number
  leverage: number
  positionSizeUsdc: number
  status: PaperTradeStatus
  duration: Duration
  /** ISO timestamp when monitoring started. */
  startedAt: string
  /** ISO timestamp when monitoring ended (TP/SL/expiry/cancel). */
  closedAt?: string
  /** Last polled price at close. */
  closedPrice?: number
  /** Simulated PnL in USDC. */
  pnlUsdc?: number
  /** Simulated PnL as percentage. */
  pnlPercent?: number
  /** Price at last poll. Used for cross-detection. */
  lastCheckedPrice?: number
  /** ISO timestamp of last poll. */
  lastCheckedAt?: string
  /** Stored trade plan for reference. */
  tradePlan: unknown
  /** Stored DD report for reference. */
  ddReport?: unknown
  /** ISO creation timestamp. */
  createdAt: string
}

/**
 * Price snapshot from a single poll.
 */
export interface PriceSnapshot {
  price: number
  source: "hyperliquid" | "fallback"
  fetchedAt: string
}

/**
 * Cross-detection result between two price points.
 */
export interface CrossDetectionResult {
  /** Whether take-profit was crossed between lastPrice and currentPrice. */
  tpCrossed: boolean
  /** Whether stop-loss was crossed between lastPrice and currentPrice. */
  slCrossed: boolean
  /** If crossed, the estimated fill price (interpolated). */
  fillPrice?: number
}
