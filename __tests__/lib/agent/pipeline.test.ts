import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/agent/due-diligence/agent", () => ({
  runDDAgent: vi.fn(),
}))

import { runDDPipeline } from "@/lib/agent/pipeline"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import type { DDReport } from "@/lib/agent/types"

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "major",
  timestamp: new Date().toISOString(),
  sections: {
    technical: { score: 80, summary: "Strong technicals", signals: [] },
    onchain: { score: 75, summary: "Healthy onchain", signals: [] },
    sentiment: { score: 70, summary: "Neutral sentiment", signals: [] },
    fundamental: { score: 85, summary: "Solid fundamentals", signals: [] },
  },
  aggregated_thesis: "BTC shows strong fundamentals",
  confidence_score: 80,
  risk_flags: [],
  factorReports: [],
  overallScore: 78,
  overallConfidence: 80,
  crossValidation: { pairs: [], overallAlignment: 0, contradictions: [] },
  risks: [],
  catalysts: [],
  summary: "BTC is strong",
  iterations: 1,
  status: "complete",
  processingTimeMs: 1200,
}

describe("runDDPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns valid pipeline output for known asset", async () => {
    vi.mocked(runDDAgent).mockResolvedValueOnce(mockDDReport)

    const output = await runDDPipeline({ asset: "BTC", userId: "user1" })

    expect(output).toHaveProperty("report")
    expect(output).toHaveProperty("timing")
    expect(output.report.asset).toBe("BTC")
    expect(output.report.category).toBe("major")
    expect(output.report.aggregated_thesis).toBe("BTC shows strong fundamentals")
    expect(output.report.confidence_score).toBe(80)
  })

  it("includes timing information", async () => {
    vi.mocked(runDDAgent).mockResolvedValueOnce(mockDDReport)

    const output = await runDDPipeline({ asset: "BTC", userId: "user1" })

    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.agentMs).toBe(1200)
  })
})
