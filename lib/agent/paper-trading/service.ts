/**
 * @file lib/agent/paper-trading/service.ts
 * @description Paper trading monitoring service. Polls Hyperliquid for prices,
 *   detects TP/SL crosses between polls, auto-closes trades, and records
 *   outcomes to ArangoDB graph memory.
 * @module paper-trading-service
 * @layer agent
 */

import { createHLClient } from "@/lib/data/hyperliquid"
import { getDb } from "@/lib/db/arango-client"
import { recordOutcome } from "@/lib/db/graph-memory"
import { createLogger } from "@/lib/agent/shared/logger"
import {
  DURATION_MS,
  type Duration,
  type PaperTrade,
  type PaperTradeStatus,
  type PriceSnapshot,
  type CrossDetectionResult,
} from "./types"

const log = createLogger({ service: "paper-trading" })

/** Polling interval in ms. Default 5 minutes. */
const POLL_INTERVAL_MS = Number(process.env.PAPER_TRADING_POLL_INTERVAL_MS) || 5 * 60 * 1000

/** Active polling intervals keyed by paper trade _key. */
const activePollers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Fetch current mid price for an asset from Hyperliquid.
 * Returns null if fetch fails (fail-closed — skip poll on stale data).
 */
export async function pollPrice(asset: string): Promise<PriceSnapshot | null> {
  try {
    const client = createHLClient()
    const mid = await client.allMids()
    const price = mid[asset]
    if (price === undefined || price === null) {
      log("warn", "price_fetch_missing", { asset })
      return null
    }
    return {
      price: Number(price),
      source: "hyperliquid",
      fetchedAt: new Date().toISOString(),
    }
  } catch (err) {
    log("error", "price_fetch_failed", { asset, error: String(err) })
    return null
  }
}

/**
 * Detect if TP or SL was crossed between two price points.
 * Uses directional cross detection (long: price >= TP or <= SL; short: inverse).
 */
export function detectCross(
  lastPrice: number,
  currentPrice: number,
  tp: number,
  sl: number,
  side: "long" | "short",
): CrossDetectionResult {
  if (side === "long") {
    const tpCrossed = lastPrice < tp && currentPrice >= tp
    const slCrossed = lastPrice > sl && currentPrice <= sl
    let fillPrice: number | undefined
    if (tpCrossed) fillPrice = tp
    if (slCrossed) fillPrice = sl
    return { tpCrossed, slCrossed, fillPrice }
  }

  // short side: price going down = profit
  const tpCrossed = lastPrice > tp && currentPrice <= tp
  const slCrossed = lastPrice < sl && currentPrice >= sl
  let fillPrice: number | undefined
  if (tpCrossed) fillPrice = tp
  if (slCrossed) fillPrice = sl
  return { tpCrossed, slCrossed, fillPrice }
}

/**
 * Compute simulated PnL for a paper trade closed at a given price.
 */
function computePnl(
  trade: PaperTrade,
  closedPrice: number,
): { pnlUsdc: number; pnlPercent: number } {
  const priceDiff = trade.side === "long"
    ? closedPrice - trade.entryPrice
    : trade.entryPrice - closedPrice
  const pnlPercent = (priceDiff / trade.entryPrice) * 100 * trade.leverage
  const pnlUsdc = (pnlPercent / 100) * trade.positionSizeUsdc
  return { pnlUsdc, pnlPercent }
}

/**
 * Close a paper trade: update status in ArangoDB, record outcome to graph memory.
 */
export async function closePaperTrade(
  key: string,
  status: PaperTradeStatus,
  closedPrice: number,
): Promise<void> {
  const db = getDb()
  if (!db) {
    log("error", "close_no_db", { key, status })
    return
  }

  const collection = db.collection("paper_trades")
  const trade = await collection.document(key).catch(() => null)
  if (!trade) {
    log("error", "close_trade_not_found", { key })
    return
  }

  const { pnlUsdc, pnlPercent } = computePnl(trade as unknown as PaperTrade, closedPrice)
  const now = new Date().toISOString()

  await collection.update(key, {
    status,
    closedAt: now,
    closedPrice,
    pnlUsdc,
    pnlPercent,
    lastCheckedPrice: closedPrice,
    lastCheckedAt: now,
  })

  // Record to outcomes collection for graph memory learning
  const result = pnlUsdc > 0 ? "profit" : pnlUsdc < 0 ? "loss" : "breakeven"
  const decisionKey = (trade as unknown as PaperTrade)._key ?? key
  await recordOutcome(decisionKey, {
    result: result as "profit" | "loss" | "breakeven",
    pnlUsdc,
    pnlPercent,
    exitPrice: closedPrice,
    exitReason: status,
  })

  log("info", "paper_trade_closed", { key, status, closedPrice, pnlUsdc, pnlPercent })
}

/**
 * Single polling tick: fetch price, detect cross, update trade.
 * Returns true if the trade should continue, false if closed.
 */
async function tick(paperTradeKey: string): Promise<boolean> {
  const db = getDb()
  if (!db) return false

  const collection = db.collection("paper_trades")
  const trade = await collection.document(paperTradeKey).catch(() => null)
  if (!trade || trade.status !== "active") return false

  const asset = trade.asset as string
  const snapshot = await pollPrice(asset)
  if (!snapshot) {
    log("warn", "tick_skip_stale", { paperTradeKey, asset })
    return true // skip this tick, retry next interval
  }

  const lastPrice = trade.lastCheckedPrice as number | undefined
  const currentPrice = snapshot.price
  const tp = trade.takeProfit as number
  const sl = trade.stopLoss as number
  const side = trade.side as "long" | "short"

  // Cross-detection if we have a previous price
  if (lastPrice !== undefined && lastPrice !== null) {
    const cross = detectCross(lastPrice, currentPrice, tp, sl, side)
    if (cross.tpCrossed) {
      await closePaperTrade(paperTradeKey, "tp_hit", cross.fillPrice ?? tp)
      return false
    }
    if (cross.slCrossed) {
      await closePaperTrade(paperTradeKey, "sl_hit", cross.fillPrice ?? sl)
      return false
    }
  }

  // Check duration expiry
  const startedAt = new Date(trade.startedAt as string).getTime()
  const durationMs = DURATION_MS[trade.duration as Duration]
  if (Date.now() >= startedAt + durationMs) {
    await closePaperTrade(paperTradeKey, "expired", currentPrice)
    return false
  }

  // Update last checked price
  await collection.update(paperTradeKey, {
    lastCheckedPrice: currentPrice,
    lastCheckedAt: snapshot.fetchedAt,
  })

  return true
}

/**
 * Start monitoring a paper trade. Fire-and-forget — does not block the caller.
 * Polls price every POLL_INTERVAL_MS until TP/SL hit, duration expires, or trade cancelled.
 */
export function startMonitoring(paperTradeKey: string): void {
  if (activePollers.has(paperTradeKey)) {
    log("warn", "monitor_already_active", { paperTradeKey })
    return
  }

  log("info", "monitor_start", { paperTradeKey, intervalMs: POLL_INTERVAL_MS })

  const interval = setInterval(async () => {
    try {
      const shouldContinue = await tick(paperTradeKey)
      if (!shouldContinue) {
        clearInterval(interval)
        activePollers.delete(paperTradeKey)
        log("info", "monitor_stop", { paperTradeKey })
      }
    } catch (err) {
      log("error", "tick_error", { paperTradeKey, error: String(err) })
      // Don't stop poller on transient errors — retry next interval
    }
  }, POLL_INTERVAL_MS)

  activePollers.set(paperTradeKey, interval)
}

/**
 * Stop monitoring a paper trade (e.g. on manual cancellation).
 */
export function stopMonitoring(paperTradeKey: string): void {
  const interval = activePollers.get(paperTradeKey)
  if (interval) {
    clearInterval(interval)
    activePollers.delete(paperTradeKey)
    log("info", "monitor_stopped_manual", { paperTradeKey })
  }
}

/**
 * Get the number of currently active paper trade monitors.
 */
export function getActiveMonitorCount(): number {
  return activePollers.size
}
