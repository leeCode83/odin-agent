import { NextRequest, NextResponse } from "next/server"
import { pollOrderStatus } from "@/lib/agent/execution/ws-monitor"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const oidParam = searchParams.get("oid")

  if (!oidParam) {
    return NextResponse.json(
      { error: "oid query parameter required" },
      { status: 400 }
    )
  }

  const oid = Number(oidParam)
  if (isNaN(oid) || oid <= 0) {
    return NextResponse.json(
      { error: "Invalid oid — must be a positive integer" },
      { status: 400 }
    )
  }

  try {
    const result = await pollOrderStatus(oid, 2_000, 8)
    return NextResponse.json({
      oid,
      status: result.status === "filled" ? "filled" : result.status === "none" ? "pending" : result.status,
      fillAmount: result.fillAmount ?? null,
      fillPrice: result.fillPrice ?? null,
    })
  } catch (err) {
    console.error("Status polling error:", err)
    return NextResponse.json(
      { error: "Failed to fetch order status", detail: String(err) },
      { status: 500 }
    )
  }
}
