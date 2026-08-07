/**
 * @file app/api/agent/paper-trading/route.ts
 * @description POST /api/agent/paper-trading — creates a paper trade.
 *   Runs the DD → Planning pipeline to generate a trade plan (or accepts
 *   a pre-built planReport), stores it in ArangoDB, and starts price
 *   monitoring via fire-and-forget polling.
 * @module paper-trading-route
 * @layer api
 */

import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db/arango-client"
import { getCategory } from "@/lib/asset-categories"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { readRecentDDReport } from "@/lib/db/graph-memory"
import { createLogger } from "@/lib/agent/shared/logger"
import { PaperTradeInputSchema, type PaperTrade, type Duration } from "@/lib/agent/paper-trading/types"
import { startMonitoring } from "@/lib/agent/paper-trading/service"
import type { DDReport } from "@/lib/agent/types"

const log = createLogger({ route: "paper-trading" })

/**
 * POST /api/agent/paper-trading
 *
 * Creates a paper trade and starts price monitoring.
 *
 * @example Request body:
 * ```json
 * {
 *   "asset": "BTC",
 *   "userId": "user123",
 *   "walletAddress": "0x...",
 *   "duration": "24h",
 *   "targetProfitPercent": 5,
 *   "planReport": { ... }
 * }
 * ```
 *
 * @returns 201 with paper trade ID and status, or error.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const parsed = PaperTradeInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", detail: parsed.error.issues },
      { status: 400 },
    )
  }

  const { asset, userId, walletAddress, targetProfitPercent, duration, planReport } = parsed.data

  const db = getDb()
  if (!db) {
    return NextResponse.json(
      { error: "Database not available" },
      { status: 503 },
    )
  }

  try {
    // Step 1: Resolve trade plan (from planReport or DD → Planning pipeline)
    let tradePlan: unknown
    let ddReport: unknown | undefined

    if (planReport) {
      // Use provided planReport directly — skip DD + Planning
      tradePlan = planReport
      log("info", "paper_trading.plan_report_provided", { asset, userId })
    } else {
      // Run DD → Planning pipeline
      // Try cached DD first
      try {
        const cached = await readRecentDDReport(asset, userId)
        if (cached) {
          ddReport = cached
          log("info", "paper_trading.dd_cache_hit", { asset })
        }
      } catch {
        // Cache miss — fall through to DD agent
      }

      if (!ddReport) {
        const category = getCategory(asset)
        if (!category) {
          return NextResponse.json(
            { error: `Unknown asset: ${asset}` },
            { status: 400 },
          )
        }
        try {
          ddReport = await runDDAgent({ asset, category, userId, walletAddress })
        } catch (e) {
          return NextResponse.json(
            { error: "DD_AGENT_FAILED", message: String(e) },
            { status: 422 },
          )
        }
      }

      try {
        const planningOutput = await runPlanningPipeline({
          asset,
          userId,
          walletAddress,
          targetProfitPercent,
          ddReport: ddReport as DDReport,
        })

        // ponytail: guard NO_TRADE — persist then return
        if (planningOutput.report.action === "NO_TRADE") {
          const now = new Date().toISOString()
          const noTradeRecord = {
            userId,
            walletAddress,
            asset,
            side: "long" as const,
            entryPrice: 0,
            stopLoss: 0,
            takeProfit: 0,
            leverage: 1,
            positionSizeUsdc: 0,
            status: "no_trade" as const,
            duration,
            startedAt: now,
            lastCheckedPrice: 0,
            lastCheckedAt: now,
            tradePlan: planningOutput.report,
            ddReport,
            createdAt: now,
            closedAt: now,
          }
          const collection = db.collection("paper_trades")
          const insertResult = await collection.save(noTradeRecord as unknown as Record<string, unknown>)
          log("info", "paper_trading.no_trade_persisted", { key: insertResult._key, asset })

          return NextResponse.json(
            {
              id: insertResult._key,
              status: "no_trade",
              message: "Planning agent decided no trade for this asset",
              reasoning: planningOutput.report.reasoning,
            },
            { status: 200 },
          )
        }

        tradePlan = planningOutput.report
      } catch (e) {
        return NextResponse.json(
          { error: "PLANNING_FAILED", message: String(e) },
          { status: 422 },
        )
      }
    }

    // Step 2: Create paper trade record in ArangoDB
    const now = new Date().toISOString()
    const tradePlanRecord = tradePlan as Record<string, unknown>

    const paperTrade: Omit<PaperTrade, "_key"> = {
      userId,
      walletAddress,
      asset,
      side: (tradePlanRecord.side as "long" | "short") ?? "long",
      entryPrice: Number(tradePlanRecord.entry_price) || 0,
      stopLoss: Number(tradePlanRecord.stop_loss) || 0,
      takeProfit: Number(tradePlanRecord.take_profit) || 0,
      leverage: Number(tradePlanRecord.leverage) || 1,
      positionSizeUsdc: Number(tradePlanRecord.position_size_usdc) || 0,
      status: "active",
      duration,
      startedAt: now,
      lastCheckedPrice: Number(tradePlanRecord.entry_price) || 0,
      lastCheckedAt: now,
      tradePlan,
      ddReport,
      createdAt: now,
    }

    const collection = db.collection("paper_trades")
    const insertResult = await collection.save(paperTrade as unknown as Record<string, unknown>)
    const paperTradeKey = insertResult._key

    log("info", "paper_trading.created", {
      key: paperTradeKey,
      asset,
      side: paperTrade.side,
      entryPrice: paperTrade.entryPrice,
      duration,
    })

    // Step 3: Start monitoring (fire-and-forget)
    startMonitoring(paperTradeKey)

    return NextResponse.json(
      {
        id: paperTradeKey,
        status: "active",
        asset,
        side: paperTrade.side,
        entryPrice: paperTrade.entryPrice,
        stopLoss: paperTrade.stopLoss,
        takeProfit: paperTrade.takeProfit,
        leverage: paperTrade.leverage,
        duration,
        startedAt: now,
      },
      { status: 201 },
    )
  } catch (err) {
    log("error", "paper_trading.error", { asset, userId, error: String(err) })
    return NextResponse.json(
      { error: "PAPER_TRADING_FAILED", message: String(err) },
      { status: 500 },
    )
  }
}
