import { describe, it, expect } from "vitest"
import { SectionResultSchema, DDReportSchema, SECTION_KEYS } from "@/lib/agent/types"

describe("SECTION_KEYS", () => {
  it("contains all 4 factors", () => {
    expect(SECTION_KEYS).toContain("technical")
    expect(SECTION_KEYS).toContain("onchain")
    expect(SECTION_KEYS).toContain("sentiment")
    expect(SECTION_KEYS).toContain("fundamental")
  })
})

describe("SectionResultSchema", () => {
  it("validates a complete section result", () => {
    const result = SectionResultSchema.parse({
      score: 72,
      summary: "Bullish momentum",
      signals: ["RSI oversold", "MACD cross"],
    })
    expect(result.score).toBe(72)
    expect(result.signals).toHaveLength(2)
  })

  it("validates a null section (inactive factor)", () => {
    const result = SectionResultSchema.parse({
      score: null,
      summary: null,
      signals: [],
    })
    expect(result.score).toBeNull()
  })

  it("rejects score outside 0-100", () => {
    expect(() => SectionResultSchema.parse({
      score: 150,
      summary: "bad",
      signals: [],
    })).toThrow()
  })

  it("rejects non-array signals", () => {
    expect(() => SectionResultSchema.parse({
      score: 50,
      summary: "test",
      signals: "not array",
    })).toThrow()
  })
})

describe("DDReportSchema", () => {
  const validReport = {
    asset: "BTC",
    category: "major",
    timestamp: "2026-07-16T10:00:00Z",
    sections: {
      technical: { score: 72, summary: "bullish", signals: ["RSI"] },
      onchain: { score: 65, summary: "neutral", signals: ["OI up"] },
      sentiment: { score: null, summary: null, signals: [] },
      fundamental: { score: null, summary: null, signals: [] },
    },
    aggregated_thesis: "BTC looks good",
    confidence_score: 78,
    risk_flags: [],
    errors: [],
  }

  it("validates a complete DD report", () => {
    const result = DDReportSchema.parse(validReport)
    expect(result.asset).toBe("BTC")
    expect(result.confidence_score).toBe(78)
  })

  it("rejects report with missing asset", () => {
    const noAsset = { ...validReport }
    delete (noAsset as Record<string, unknown>).asset
    expect(() => DDReportSchema.parse(noAsset)).toThrow()
  })

  it("rejects report with missing section key", () => {
    const bad = { ...validReport, sections: { technical: validReport.sections.technical } }
    expect(() => DDReportSchema.parse(bad)).toThrow()
  })

  it("accepts report without errors field (optional)", () => {
    const noErrors = { ...validReport }
    delete (noErrors as Record<string, unknown>).errors
    const result = DDReportSchema.parse(noErrors)
    expect(result.asset).toBe("BTC")
  })

  it("rejects confidence_score outside 0-100", () => {
    expect(() => DDReportSchema.parse({
      ...validReport,
      confidence_score: 200,
    })).toThrow()
  })
})
