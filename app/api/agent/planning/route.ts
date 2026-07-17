import { NextRequest, NextResponse } from "next/server"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { DDReportSchema } from "@/lib/agent/types"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { ddReport, userId, walletAddress } = body

  if (!ddReport || !userId || !walletAddress) {
    return NextResponse.json(
      { error: "ddReport, userId, and walletAddress required" },
      { status: 400 }
    )
  }

  const parsed = DDReportSchema.safeParse(ddReport)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid ddReport", detail: parsed.error.issues },
      { status: 400 }
    )
  }

  try {
    const output = await runPlanningPipeline({
      ddReport: parsed.data,
      userId: String(userId),
      walletAddress: String(walletAddress),
    })
    return NextResponse.json(output)
  } catch (err) {
    console.error("Planning pipeline error:", err)
    return NextResponse.json(
      { error: "Planning pipeline failed", detail: String(err) },
      { status: 500 }
    )
  }
}
