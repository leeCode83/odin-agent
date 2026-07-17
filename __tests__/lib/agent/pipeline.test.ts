import { describe, it, expect, vi, beforeEach } from "vitest"
import { runDDPipeline } from "@/lib/agent/pipeline"

vi.mock("@/lib/asset-categories", () => ({
  getCategory: vi.fn(),
  getCategoryName: vi.fn(),
}))

vi.mock("@/lib/data/providers", () => ({
  fetchAllRawData: vi.fn(),
}))

vi.mock("@/lib/agent/due-diligence/llm", () => ({
  analyzeSection: vi.fn(),
  synthesizeSections: vi.fn(),
}))

import { getCategory, getCategoryName } from "@/lib/asset-categories"
import { fetchAllRawData } from "@/lib/data/providers"
import type { RawFactorData } from "@/lib/data/providers"
import { analyzeSection, synthesizeSections } from "@/lib/agent/due-diligence/llm"

const MOCK_SECTION = { score: 70, summary: "bullish", signals: ["signal"] }
const MOCK_SYNTHESIS = { thesis: "BTC looks good", confidence: 75, flags: [], errors: [] }

describe("runDDPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCategory).mockReturnValue({ name: "major", activeFactors: ["technical", "onchain", "sentiment", "fundamental"] })
    vi.mocked(getCategoryName).mockReturnValue("major")
    vi.mocked(fetchAllRawData).mockResolvedValue({
      technical: MOCK_SECTION,
      onchain: MOCK_SECTION,
      sentiment: null,
      fundamental: null,
    } as unknown as RawFactorData)
    vi.mocked(analyzeSection).mockResolvedValue(MOCK_SECTION)
    vi.mocked(synthesizeSections).mockResolvedValue(MOCK_SYNTHESIS)
  })

  it("returns valid pipeline output for known asset", async () => {
    const output = await runDDPipeline({ asset: "BTC", userId: "user1" })

    expect(output).toHaveProperty("report")
    expect(output).toHaveProperty("timing")
    expect(output.report.asset).toBe("BTC")
    expect(output.report.category).toBe("major")
    expect(output.report.aggregated_thesis).toBe("BTC looks good")
    expect(output.report.confidence_score).toBe(75)
  })

  it("calls LLM only for active factors", async () => {
    vi.mocked(getCategory).mockReturnValue({ name: "meme", activeFactors: ["technical", "onchain", "sentiment"] })

    await runDDPipeline({ asset: "DOGE", userId: "user1" })

    expect(analyzeSection).toHaveBeenCalledTimes(3)
  })

  it("fills inactive sections with null defaults", async () => {
    vi.mocked(getCategory).mockReturnValue({ name: "meme", activeFactors: ["technical"] })

    const output = await runDDPipeline({ asset: "DOGE", userId: "user1" })

    expect(output.report.sections.technical.score).toBe(70)
    expect(output.report.sections.onchain.score).toBeNull()
    expect(output.report.sections.sentiment.score).toBeNull()
    expect(output.report.sections.fundamental.score).toBeNull()
  })

  it("throws for unknown asset", async () => {
    vi.mocked(getCategory).mockReturnValue(null)

    await expect(runDDPipeline({ asset: "UNKNOWN", userId: "user1" })).rejects.toThrow("Unknown asset")
  })

  it("includes timing information", async () => {
    const output = await runDDPipeline({ asset: "BTC", userId: "user1" })

    expect(output.timing.fetchMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.llmMs).toBeGreaterThanOrEqual(0)
    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0)
  })

  it("works with all sections resolving", async () => {
    vi.mocked(analyzeSection).mockResolvedValue(MOCK_SECTION)

    const output = await runDDPipeline({ asset: "BTC", userId: "user1" })

    expect(output.report).toBeDefined()
    expect(analyzeSection).toHaveBeenCalledTimes(4)
  })
})
