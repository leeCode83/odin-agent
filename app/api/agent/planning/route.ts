import { NextRequest, NextResponse } from "next/server"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { DDReportSchema, TradePlanSchema } from "@/lib/agent/types"

/**
 * @function POST
 * @description API endpoint for running the Planning pipeline based on a DD report.
 * @param {NextRequest} req - The incoming Next.js request containing ddReport, userId, and walletAddress.
 * @returns {Promise<NextResponse>} JSON response containing the execution plan or an error.
 */
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
    const validated = TradePlanSchema.parse(output.plan)
    return NextResponse.json({ ...output, plan: validated })
  } catch (err) {
    console.error("Planning pipeline error:", err)
    return NextResponse.json(
      { error: "Planning pipeline failed", detail: String(err) },
      { status: 500 }
    )
  }
}
