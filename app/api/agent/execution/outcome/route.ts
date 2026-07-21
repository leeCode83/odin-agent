import { NextRequest, NextResponse } from "next/server"
import { recordOutcome } from "@/lib/db/graph-memory"

const VALID_RESULTS = ["profit", "loss", "breakeven", "cancelled"]

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { decisionKey, result } = body

  if (!decisionKey || !result) {
    return NextResponse.json(
      { error: "decisionKey and result required" },
      { status: 400 }
    )
  }

  if (!VALID_RESULTS.includes(String(result))) {
    return NextResponse.json(
      { error: "Invalid result. Must be profit/loss/breakeven/cancelled" },
      { status: 400 }
    )
  }

  try {
    const outcomeKey = await recordOutcome(String(decisionKey), {
      result: result as "profit" | "loss" | "breakeven" | "cancelled",
      pnlUsdc: body.pnlUsdc ? Number(body.pnlUsdc) : undefined,
      pnlPercent: body.pnlPercent ? Number(body.pnlPercent) : undefined,
      exitPrice: body.exitPrice ? Number(body.exitPrice) : undefined,
      exitReason: body.exitReason ? String(body.exitReason) : undefined,
    })

    return NextResponse.json({
      recorded: true,
      decisionKey: String(decisionKey),
      outcomeKey,
    })
  } catch (err) {
    console.error("Outcome recording error:", err)
    return NextResponse.json(
      { error: "Failed to record outcome", detail: String(err) },
      { status: 500 }
    )
  }
}
