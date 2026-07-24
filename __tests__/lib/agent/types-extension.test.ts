import { describe, it, expect } from "vitest"
import { DDReportSchema } from "@/lib/agent/types"

describe("DDReport Extension", () => {
  const oldFormat = {
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

  it("parses old DDReport format (backward compat)", () => {
    const result = DDReportSchema.parse(oldFormat)
    expect(result.asset).toBe("BTC")
    expect(result.confidence_score).toBe(78)
  })

  it("parses extended DDReport with all new fields", () => {
    const extended = {
      ...oldFormat,
      factorReports: [
        {
          factor: "technical",
          score: 72,
          confidence: 80,
          signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
          dataSources: ["hyperliquid"],
          reasoning: "Strong momentum",
          iterations: 3,
          conclusion: "Bullish",
          errors: [],
        },
      ],
      overallScore: 75,
      overallConfidence: 80,
      crossValidation: {
        pairs: [
          { factorA: "technical", factorB: "onchain", alignment: 85, note: "Aligned" },
        ],
        overallAlignment: 85,
        contradictions: [],
      },
      risks: [
        { factor: "technical", description: "Overbought", severity: "medium" },
      ],
      catalysts: [
        { factor: "fundamental", description: "ETF inflow", impact: "high" },
      ],
      summary: "Bullish outlook",
      iterations: 5,
      status: "complete",
      processingTimeMs: 1234,
    }
    const result = DDReportSchema.parse(extended)
    expect(result.asset).toBe("BTC")
    expect(result.overallScore).toBe(75)
    expect(result.factorReports).toHaveLength(1)
    expect(result.status).toBe("complete")
  })

  it("treats all new fields as optional", () => {
    const result = DDReportSchema.parse(oldFormat)
    expect(result.overallScore).toBeUndefined()
    expect(result.factorReports).toBeUndefined()
    expect(result.crossValidation).toBeUndefined()
    expect(result.risks).toBeUndefined()
    expect(result.catalysts).toBeUndefined()
    expect(result.summary).toBeUndefined()
    expect(result.iterations).toBeUndefined()
    expect(result.status).toBeUndefined()
    expect(result.processingTimeMs).toBeUndefined()
  })

  it("parses without optional old fields", () => {
    const minimal = {
      asset: "ETH",
      category: "major",
      timestamp: "2026-07-16T10:00:00Z",
      sections: {
        technical: { score: null, summary: null, signals: [] },
        onchain: { score: null, summary: null, signals: [] },
        sentiment: { score: null, summary: null, signals: [] },
        fundamental: { score: null, summary: null, signals: [] },
      },
      risk_flags: [],
    }
    const result = DDReportSchema.parse(minimal)
    expect(result.asset).toBe("ETH")
    expect(result.aggregated_thesis).toBeUndefined()
    expect(result.confidence_score).toBeUndefined()
  })
})
