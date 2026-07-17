import { describe, it, expect } from "vitest"
import {
  SectionResultSchema, DDReportSchema, SECTION_KEYS,
  SideSchema, AutonomyDecisionSchema, ConfidenceBreakdownSchema,
  GraphPatternSchema, RiskThresholdsSchema, TradePlanSchema,
} from "@/lib/agent/types"

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

describe("SideSchema", () => {
  it("accepts long", () => {
    expect(SideSchema.parse("long")).toBe("long")
  })
  it("accepts short", () => {
    expect(SideSchema.parse("short")).toBe("short")
  })
  it("rejects invalid side", () => {
    expect(() => SideSchema.parse("buy")).toThrow()
  })
})

describe("AutonomyDecisionSchema", () => {
  it("accepts auto", () => {
    expect(AutonomyDecisionSchema.parse("auto")).toBe("auto")
  })
  it("accepts approve", () => {
    expect(AutonomyDecisionSchema.parse("approve")).toBe("approve")
  })
})

describe("ConfidenceBreakdownSchema", () => {
  const valid = { factor_alignment: 80, historical_match: 50, signal_strength: 70 }
  it("validates complete breakdown", () => {
    expect(ConfidenceBreakdownSchema.parse(valid)).toEqual(valid)
  })
  it("rejects score outside 0-100", () => {
    expect(() => ConfidenceBreakdownSchema.parse({ ...valid, factor_alignment: 150 })).toThrow()
  })
})

describe("GraphPatternSchema", () => {
  it("validates graph pattern", () => {
    const result = GraphPatternSchema.parse({ pattern: "BTC rsi oversold", outcome: "profit", frequency: 3 })
    expect(result.frequency).toBe(3)
  })
})

describe("RiskThresholdsSchema", () => {
  const valid = { confidence_threshold: 70, max_position_usdc: 100, max_leverage: 10, risk_per_trade_percent: 1 }
  it("validates complete thresholds", () => {
    expect(RiskThresholdsSchema.parse(valid)).toEqual(valid)
  })
  it("rejects confidence_threshold outside 0-100", () => {
    expect(() => RiskThresholdsSchema.parse({ ...valid, confidence_threshold: 200 })).toThrow()
  })
})

describe("TradePlanSchema", () => {
  const validPlan = {
    asset: "BTC",
    side: "long",
    entry_price: 65000.50,
    position_size_usdc: 100,
    position_size_contracts: 0.0015,
    stop_loss: 62000.00,
    take_profit: 71000.00,
    leverage: 5,
    confidence_score: 78,
    confidence_breakdown: { factor_alignment: 80, historical_match: 50, signal_strength: 70 },
    thesis: "BTC bullish due to strong onchain activity",
    reasoning: "Technical + onchain alignment suggests upward momentum",
    autonomy_decision: "auto",
    risk_flags: [],
    graph_patterns_used: [{ pattern: "BTC rsi oversold", outcome: "profit", frequency: 3 }],
    timestamp: "2026-07-16T10:00:00Z",
  }
  it("validates a complete trade plan", () => {
    const result = TradePlanSchema.parse(validPlan)
    expect(result.asset).toBe("BTC")
    expect(result.side).toBe("long")
    expect(result.confidence_score).toBe(78)
    expect(result.graph_patterns_used).toHaveLength(1)
  })
  it("rejects plan with negative price", () => {
    expect(() => TradePlanSchema.parse({ ...validPlan, entry_price: -1 })).toThrow()
  })
  it("rejects plan with invalid autonomy decision", () => {
    expect(() => TradePlanSchema.parse({ ...validPlan, autonomy_decision: "maybe" })).toThrow()
  })
})
