import { NextRequest, NextResponse } from "next/server"
import { runDDPipeline } from "@/lib/agent/pipeline"
import { DDReportSchema } from "@/lib/agent/types"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { asset, userId } = body

  if (!asset || !userId) {
    return NextResponse.json({ error: "asset and userId required" }, { status: 400 })
  }

  try {
    const output = await runDDPipeline({ asset: String(asset), userId: String(userId) })
    const parsed = DDReportSchema.parse(output.report)
    return NextResponse.json({ ...output, report: parsed })
  } catch (err) {
    console.error("DD pipeline error:", err)
    return NextResponse.json(
      { error: "DD pipeline failed", detail: String(err) },
      { status: 500 }
    )
  }
}
