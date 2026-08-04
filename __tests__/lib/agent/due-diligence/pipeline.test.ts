import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/agent/due-diligence/agent", () => ({
  runDDAgent: vi.fn(),
}))

vi.mock("@/lib/asset-categories", () => ({
  getCategory: vi.fn(),
  getCategoryName: vi.fn(),
}))

import { runDDPipeline } from "@/lib/agent/due-diligence/pipeline"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import { getCategory, getCategoryName } from "@/lib/asset-categories"
import type { DDReport } from "@/lib/agent/types"

const mockCategory = { name: "major", activeFactors: [...["technical", "onchain", "sentiment", "fundamental"] as const] }

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
  aggregated_thesis: "BTC shows strong fundamentals and technical setup",
  confidence_score: 80,
  risk_flags: [],
  factorReports: [],
  overallScore: 78,
  overallConfidence: 80,
  crossValidation: { pairs: [], overallAlignment: 0, contradictions: [] },
  risks: [],
  catalysts: [],
  summary: "BTC is a strong investment",
  iterations: 1,
  status: "complete",
  processingTimeMs: 1500,
}

describe("runDDPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCategory).mockReturnValue(mockCategory)
    vi.mocked(getCategoryName).mockReturnValue("major")
  })

  it("calls runDDAgent and returns DDReport with timing", async () => {
    vi.mocked(runDDAgent).mockResolvedValueOnce(mockDDReport)

    const result = await runDDPipeline({ asset: "BTC", userId: "user-1" })

    expect(runDDAgent).toHaveBeenCalledWith({
      asset: "BTC",
      category: mockCategory,
      userId: "user-1",
    })
    expect(result.report).toEqual(mockDDReport)
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    expect(result.timing.agentMs).toBe(1500)
    expect(result.timing.agentMs).toBe(1500)
  })

  it("throws on unknown asset", async () => {
    vi.mocked(getCategory).mockReturnValueOnce(null)

    await expect(runDDPipeline({ asset: "UNKNOWN", userId: "user-1" })).rejects.toThrow(
      /Unknown asset: UNKNOWN/
    )
  })

  it("handles runDDAgent error gracefully", async () => {
    vi.mocked(runDDAgent).mockRejectedValueOnce(new Error("Agent crashed"))

    await expect(runDDPipeline({ asset: "BTC", userId: "user-1" })).rejects.toThrow(
      /DD Pipeline failed for BTC.*Agent crashed/
    )
  })
})
