/**
 * @file route.ts (close/[coin])
 * @description POST /api/agent/execution/close/{coin} — Close filled positions for a specific coin.
 * Cancels open orders for that coin first, then places reduceOnly IoC order.
 * @module execution/close
 * @layer controller
 */
import { NextRequest, NextResponse } from "next/server"
import { closePositionForCoin } from "@/lib/agent/execution/close"
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ coin: string }> }
) {
  const agentPk = process.env.AGENT_PRIVATE_KEY
  const agentAddr = process.env.AGENT_WALLET_ADDRESS

  if (!agentPk) {
    return NextResponse.json(
      { error: "Agent wallet not initialized" },
      { status: 503 }
    )
  }

  const { coin } = await params

  if (!coin) {
    return NextResponse.json(
      { error: "Coin parameter required" },
      { status: 400 }
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
    // Reason: validate coin exists in Hyperliquid universe before attempting to close
    const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet }) })
    const [meta] = await info.metaAndAssetCtxs()
    const exists = meta.universe.some((u: { name: string }) => u.name === coin)
    if (!exists) {
      return NextResponse.json(
        { error: `Coin ${coin} not found in Hyperliquid universe` },
        { status: 404 }
      )
    }

    const result = await closePositionForCoin(coin, agentPk, agentAddr, walletAddress)
    return NextResponse.json(result)
  } catch (err) {
    console.error("Close position error:", err)
    return NextResponse.json(
      { error: "HL exchange error", detail: String(err) },
      { status: 502 }
    )
  }
}
