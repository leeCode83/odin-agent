/**
 * @file app/api/agent/paper-trading/[id]/route.ts
 * @description GET /api/agent/paper-trading/[id] — retrieves paper trade status.
 * @module paper-trading-id-route
 * @layer api
 */

import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db/arango-client"
import { createLogger } from "@/lib/agent/shared/logger"

const log = createLogger({ route: "paper-trading-id" })

/**
 * GET /api/agent/paper-trading/[id]
 *
 * Returns the current status and details of a paper trade.
 *
 * @param req - Next.js request (unused for GET).
 * @param params - Route params with `id` (paper trade key).
 * @returns 200 with paper trade data, or 404/500.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: "Missing paper trade ID" }, { status: 400 })
  }

  const db = getDb()
  if (!db) {
    return NextResponse.json({ error: "Database not available" }, { status: 503 })
  }

  try {
    const collection = db.collection("paper_trades")
    const trade = await collection.document(id).catch(() => null)

    if (!trade) {
      return NextResponse.json({ error: "Paper trade not found" }, { status: 404 })
    }

    return NextResponse.json({
      id: trade._key,
      asset: trade.asset,
      side: trade.side,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      leverage: trade.leverage,
      positionSizeUsdc: trade.positionSizeUsdc,
      status: trade.status,
      duration: trade.duration,
      startedAt: trade.startedAt,
      closedAt: trade.closedAt,
      closedPrice: trade.closedPrice,
      pnlUsdc: trade.pnlUsdc,
      pnlPercent: trade.pnlPercent,
      lastCheckedPrice: trade.lastCheckedPrice,
      lastCheckedAt: trade.lastCheckedAt,
      createdAt: trade.createdAt,
    })
  } catch (err) {
    log("error", "paper_trade_fetch_error", { id, error: String(err) })
    return NextResponse.json({ error: "Failed to fetch paper trade" }, { status: 500 })
  }
}
