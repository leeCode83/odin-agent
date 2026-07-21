import { NextRequest, NextResponse } from "next/server"
import { rejectTradePlan } from "@/lib/agent/pipeline"
import { TradePlanSchema } from "@/lib/agent/types"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { tradePlan, userId } = body

  if (!tradePlan || !userId) {
    return NextResponse.json(
      { error: "tradePlan and userId required" },
      { status: 400 }
    )
  }

  const parsedPlan = TradePlanSchema.safeParse(tradePlan)
  if (!parsedPlan.success) {
    return NextResponse.json(
      { error: "Invalid tradePlan", detail: parsedPlan.error.issues },
      { status: 400 }
    )
  }

  try {
    const result = await rejectTradePlan({
      tradePlan: parsedPlan.data,
      userId: String(userId),
      reason: body.reason ? String(body.reason) : undefined,
    })
    return NextResponse.json({
      status: "rejected",
      decisionKey: result.decisionKey,
      message: "Trade rejected. Decision recorded to graph memory.",
    })
  } catch (err) {
    console.error("Reject trade error:", err)
    return NextResponse.json(
      { error: "Failed to record rejection", detail: String(err) },
      { status: 500 }
    )
  }
}
