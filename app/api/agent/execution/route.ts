import { NextRequest, NextResponse } from "next/server"
import { runExecutionPipeline } from "@/lib/agent/pipeline"
import { TradePlanSchema, DDReportSchema } from "@/lib/agent/types"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { tradePlan, walletAddress, userId, ddReport } = body

  if (!tradePlan || !walletAddress || !userId) {
    return NextResponse.json(
      { error: "tradePlan, walletAddress, and userId required" },
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

  let parsedDD = undefined
  if (ddReport) {
    const parsed = DDReportSchema.safeParse(ddReport)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid ddReport", detail: parsed.error.issues },
        { status: 400 }
      )
    }
    parsedDD = parsed.data
  }

  try {
    const output = await runExecutionPipeline({
      tradePlan: parsedPlan.data,
      walletAddress: String(walletAddress),
      userId: String(userId),
      ddReport: parsedDD,
    })
    return NextResponse.json(output)
  } catch (err) {
    console.error("Execution pipeline error:", err)
    const msg = String(err)
    if (msg.includes("not initialized")) {
      return NextResponse.json({ error: "Agent wallet not initialized. Call /api/agent/execution/init first" }, { status: 503 })
    }
    if (msg.includes("manual approval")) {
      return NextResponse.json({ error: "TradePlan requires manual approval — cannot auto-execute" }, { status: 400 })
    }
    if (msg.includes("leverage")) {
      return NextResponse.json({ error: "HL exchange error (leverage)", detail: msg }, { status: 502 })
    }
    if (msg.includes("HL") || msg.includes("exchange")) {
      return NextResponse.json({ error: "HL exchange error", detail: msg }, { status: 502 })
    }
    return NextResponse.json({ error: "Execution pipeline failed", detail: msg }, { status: 500 })
  }
}
