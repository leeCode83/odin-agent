/**
 * @file route.ts
 * @description POST /api/agent/execution/close — Close all filled positions across all coins.
 * Cancels open orders first, then places reduceOnly IoC orders at aggressive prices.
 * @module execution/close
 * @layer controller
 */
import { NextRequest, NextResponse } from "next/server"
import { closeAllPositions } from "@/lib/agent/execution/close"

export async function POST(req: NextRequest) {
  const agentPk = process.env.AGENT_PRIVATE_KEY
  const agentAddr = process.env.AGENT_WALLET_ADDRESS

  if (!agentPk) {
    return NextResponse.json(
      { error: "Agent wallet not initialized" },
      { status: 503 }
    )
  }

  let walletAddress: string | undefined
  try {
    const body = await req.json()
    walletAddress = body.walletAddress
  } catch {
    // No body or invalid JSON — use env fallback
  }

  try {
    const result = await closeAllPositions(agentPk, agentAddr, walletAddress)
    return NextResponse.json(result)
  } catch (err) {
    console.error("Close all error:", err)
    return NextResponse.json(
      { error: "HL exchange error", detail: String(err) },
      { status: 502 }
    )
  }
}
