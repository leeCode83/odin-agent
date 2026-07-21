import { NextResponse } from "next/server"
import { getAgentSigner, getExchangeClient } from "@/lib/agent/execution/client"
import { InfoClient, HttpTransport } from "@nktkas/hyperliquid"

export async function POST() {
  const agentPk = process.env.AGENT_PRIVATE_KEY
  const agentAddr = process.env.AGENT_WALLET_ADDRESS

  if (!agentPk || !agentAddr) {
    return NextResponse.json(
      { error: "Agent wallet not initialized" },
      { status: 503 }
    )
  }

  try {
    const account = getAgentSigner(agentPk)
    const client = getExchangeClient(account)

    const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
    const transport = new HttpTransport({ isTestnet })
    const infoClient = new InfoClient({ transport })

    const [meta] = await infoClient.metaAndAssetCtxs()
    const coinToAsset = new Map<string, number>()
    meta.universe.forEach((u: { name: string }, i: number) => coinToAsset.set(u.name, i))

    const openOrders = await infoClient.openOrders({ user: agentAddr as `0x${string}` })
    const cancels = (openOrders as Array<{ coin: string; oid: number }>).map((o) => ({
      a: coinToAsset.get(o.coin) ?? 0,
      o: o.oid,
    }))

    if (cancels.length > 0) {
      await client.cancel({ cancels })
    }

    return NextResponse.json({
      cancelled: cancels.length,
      message: "All orders cancelled",
    })
  } catch (err) {
    console.error("Cancel error:", err)
    return NextResponse.json(
      { error: "HL exchange error", detail: String(err) },
      { status: 502 }
    )
  }
}
