import { NextRequest, NextResponse } from "next/server"
import { runTradePipeline } from "@/lib/agent/pipeline"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { asset, userId, walletAddress } = body

  if (!asset || !userId || !walletAddress) {
    return NextResponse.json(
      { error: "asset, userId, and walletAddress required" },
      { status: 400 }
    )
  }

  try {
    const output = await runTradePipeline({
      asset: String(asset),
      userId: String(userId),
      walletAddress: String(walletAddress),
    })
    return NextResponse.json(output)
  } catch (err) {
    console.error("Trade pipeline error:", err)
    const msg = String(err)
    if (msg.includes("not initialized")) {
      return NextResponse.json({ error: "Agent wallet not initialized. Call /api/agent/execution/init first" }, { status: 503 })
    }
    if (msg.includes("HL") || msg.includes("exchange") || msg.includes("leverage")) {
      return NextResponse.json({ error: "HL exchange error", detail: msg }, { status: 502 })
    }
    return NextResponse.json({ error: "Trade pipeline failed", detail: msg }, { status: 500 })
  }
}
