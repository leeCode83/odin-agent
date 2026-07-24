import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { DDReport } from "@/lib/agent/types"

vi.mock("@/lib/agent/pipeline", () => ({
  runDDPipeline: vi.fn(),
}))

import { runDDPipeline } from "@/lib/agent/pipeline"

function mockNextRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agent/dd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockInvalidRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/agent/dd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
}

const MOCK_REPORT = {
  asset: "BTC",
  category: "major",
  timestamp: "2026-07-16T10:00:00.000Z",
  sections: {
    technical: { score: 70, summary: "bullish", signals: ["signal"] },
    onchain: { score: null, summary: null, signals: [] },
    sentiment: { score: null, summary: null, signals: [] },
    fundamental: { score: null, summary: null, signals: [] },
  },
  aggregated_thesis: "BTC looks good",
  confidence_score: 75,
  risk_flags: [],
  factorReports: [
    {
      factor: "technical",
      score: 70,
      confidence: 80,
      signals: [{ name: "Signal", strength: 75, direction: "bullish" }],
      dataSources: ["source"],
      reasoning: "Technical analysis",
      iterations: 1,
      conclusion: "Bullish",
      errors: [],
    },
  ],
  overallScore: 70,
  overallConfidence: 75,
  crossValidation: {
    pairs: [
      { factorA: "technical", factorB: "onchain", alignment: 80, note: "aligned" },
    ],
    overallAlignment: 80,
    contradictions: [],
  },
  risks: [{ factor: "technical", description: "Risk", severity: "medium" }],
  catalysts: [{ factor: "fundamental", description: "Catalyst", impact: "high" }],
  summary: "BTC looks good overall",
  iterations: 1,
  status: "complete",
  processingTimeMs: 300,
}

const MOCK_TIMING = { fetchMs: 100, llmMs: 200, totalMs: 300, agentMs: 300 }

async function post(body: unknown) {
  const { POST } = await import("@/app/api/agent/dd/route")
  return POST(mockNextRequest(body))
}

describe("POST /api/agent/dd", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runDDPipeline).mockResolvedValue({
      report: MOCK_REPORT as DDReport,
      timing: MOCK_TIMING,
    })
  })

  it("returns 200 with report for valid input", async () => {
    const res = await post({ asset: "BTC", userId: "user1" })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.report.asset).toBe("BTC")
    expect(json.report.factorReports).toHaveLength(1)
    expect(json.report.overallScore).toBe(70)
    expect(json.report.overallConfidence).toBe(75)
    expect(json.report.crossValidation).toBeDefined()
    expect(json.report.risks).toHaveLength(1)
    expect(json.report.catalysts).toHaveLength(1)
    expect(json.report.summary).toBe("BTC looks good overall")
    expect(json.report.status).toBe("complete")
    expect(json.timing.totalMs).toBe(300)
    expect(json.timing.agentMs).toBe(300)
  })

  it("returns 400 when asset is missing", async () => {
    const res = await post({ userId: "user1" })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain("asset")
  })

  it("returns 400 when userId is missing", async () => {
    const res = await post({ asset: "BTC" })

    expect(res.status).toBe(400)
  })

  it("returns 400 for invalid JSON body", async () => {
    const { POST } = await import("@/app/api/agent/dd/route")
    const res = await POST(mockInvalidRequest("not json"))

    expect(res.status).toBe(400)
  })

  it("returns 500 when pipeline throws", async () => {
    vi.mocked(runDDPipeline).mockRejectedValueOnce(new Error("Something broke"))

    const res = await post({ asset: "BTC", userId: "user1" })

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe("DD pipeline failed")
  })

  it("returns error for unknown asset", async () => {
    vi.mocked(runDDPipeline).mockRejectedValueOnce(new Error("Unknown asset: XYZ"))

    const res = await post({ asset: "XYZ", userId: "user1" })

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.detail).toContain("Unknown asset: XYZ")
  })
})
