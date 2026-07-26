import { NextRequest, NextResponse } from "next/server"
import { runDDPipeline } from "@/lib/agent/pipeline"
import { DDReportSchema } from "@/lib/agent/types"

/**
 * @function POST
 * @description API endpoint for running the Due Diligence (DD) pipeline.
 * @param {NextRequest} req - The incoming Next.js request containing asset and userId.
 * @returns {Promise<NextResponse>} JSON response containing the DD report or an error.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { asset, userId, walletAddress } = body

  if (!asset || !userId) {
    return NextResponse.json({ error: "asset and userId required" }, { status: 400 })
  }

  try {
    const output = await runDDPipeline({ asset: String(asset), userId: String(userId), walletAddress: walletAddress ? String(walletAddress) : undefined })
    const parsed = DDReportSchema.parse(output.report)

    const statusCode = parsed.status === "failed" ? 500
      : parsed.status === "partial" ? 206
      : 200

    return NextResponse.json({ ...output, report: parsed }, { status: statusCode })
  } catch (err) {
    console.error("DD pipeline error:", err)
    return NextResponse.json(
      { error: "DD pipeline failed", detail: String(err) },
      { status: 500 }
    )
  }
}
