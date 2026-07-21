import { NextRequest, NextResponse } from "next/server"
import { generateAgentWallet, approveAgent } from "@/lib/agent/execution/client"

export async function POST(req: NextRequest) {
  const masterPk = process.env.MASTER_PRIVATE_KEY
  if (!masterPk) {
    return NextResponse.json(
      { error: "MASTER_PRIVATE_KEY not set in .env" },
      { status: 400 }
    )
  }

  const existingAgentPk = process.env.AGENT_PRIVATE_KEY
  const existingAgentAddr = process.env.AGENT_WALLET_ADDRESS
  if (existingAgentPk && existingAgentAddr) {
    return NextResponse.json({
      agentAddress: existingAgentAddr,
      approved: true,
      message: "Already initialized",
    })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const agentName = String(body.agentName ?? "odin")

  try {
    const { address, privateKey } = generateAgentWallet()
    await approveAgent(address as `0x${string}`, agentName)

    return NextResponse.json({
      agentAddress: address,
      agentName,
      agentPrivateKey: privateKey,
      approved: true,
      message: `Agent wallet generated. Save AGENT_PRIVATE_KEY=${privateKey} and AGENT_WALLET_ADDRESS=${address} to .env`,
    })
  } catch (err) {
    console.error("Agent init error:", err)
    return NextResponse.json(
      { error: "Agent init failed", detail: String(err) },
      { status: 500 }
    )
  }
}
