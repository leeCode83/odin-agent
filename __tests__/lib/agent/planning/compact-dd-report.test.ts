/**
 * @file __tests__/lib/agent/planning/compact-dd-report.test.ts
 * @description Unit tests for compactDDReport utility in the planning agent module.
 */

import { describe, it, expect } from "vitest"
import { compactDDReport } from "@/lib/agent/planning/utils"
import type { DDReport } from "@/lib/agent/types"

describe("compactDDReport", () => {
  const fullDDReport: DDReport = {
    asset: "BTC",
    category: "layer1",
    timestamp: "2026-08-06T08:00:00Z",
    sections: {
      technical: {
        score: 80,
        summary: "Bullish momentum on 4h timeframe.",
        signals: ["RSI oversold", "MACD bullish crossover"],
      },
      onchain: {
        score: 70,
        summary: "Accumulation by whales.",
        signals: ["Net exchange outflow"],
      },
      sentiment: {
        score: 60,
        summary: "Neutral to mildly optimistic.",
        signals: ["Fear & Greed Index at 55"],
      },
      fundamental: {
        score: 85,
        summary: "Strong network security.",
        signals: ["Hashrate at ATH"],
      },
    },
    aggregated_thesis: "Strong long setup across technical and fundamental factors.",
    confidence_score: 78,
    risk_flags: ["High volatility"],
    errors: ["Failed to fetch secondary sentiment feed"],
    factorReports: [
      {
        factor: "technical",
        score: 80,
        confidence: 85,
        signals: [{ name: "RSI", strength: 80, direction: "bullish" }],
        dataSources: ["binance", "coingecko"],
        reasoning: "Extensive 500-word reasoning text analyzing every indicator in depth...",
        iterations: 3,
        conclusion: "Technical indicators favor long entry.",
        errors: [],
        stopReason: "llm_return",
      },
    ],
    overallScore: 73,
    overallConfidence: 80,
    crossValidation: {
      pairs: [
        {
          factorA: "technical",
          factorB: "onchain",
          alignment: 85,
          note: "Both agree on bullish trend.",
        },
      ],
      overallAlignment: 85,
      contradictions: ["Sentiment lags technical score"],
    },
    risks: [
      {
        factor: "technical",
        description: "Resistance at 68,000 USD",
        severity: "medium",
      },
    ],
    catalysts: [
      {
        factor: "fundamental",
        description: "Upcoming halving event",
        impact: "high",
      },
    ],
    summary: "Overall favorable risk/reward for long position.",
    iterations: 4,
    status: "complete",
    processingTimeMs: 12500,
    usableFactorCount: 4,
  }

  it("removes factorReports from the compacted report", () => {
    const compacted = compactDDReport(fullDDReport)
    expect(compacted).not.toHaveProperty("factorReports")
  })

  it("removes execution metadata (processingTimeMs, iterations, status, usableFactorCount, errors)", () => {
    const compacted = compactDDReport(fullDDReport)
    expect(compacted).not.toHaveProperty("processingTimeMs")
    expect(compacted).not.toHaveProperty("iterations")
    expect(compacted).not.toHaveProperty("status")
    expect(compacted).not.toHaveProperty("usableFactorCount")
    expect(compacted).not.toHaveProperty("errors")
  })

  it("removes pairs from crossValidation while keeping overallAlignment and contradictions", () => {
    const compacted = compactDDReport(fullDDReport)
    expect(compacted.crossValidation).toBeDefined()
    expect(compacted.crossValidation).not.toHaveProperty("pairs")
    expect(compacted.crossValidation?.overallAlignment).toBe(85)
    expect(compacted.crossValidation?.contradictions).toEqual([
      "Sentiment lags technical score",
    ])
  })

  it("preserves critical trading fields (asset, timestamp, sections, aggregated_thesis, risks, catalysts)", () => {
    const compacted = compactDDReport(fullDDReport)
    expect(compacted.asset).toBe("BTC")
    expect(compacted.timestamp).toBe("2026-08-06T08:00:00Z")
    expect(compacted.sections).toEqual(fullDDReport.sections)
    expect(compacted.aggregated_thesis).toBe(fullDDReport.aggregated_thesis)
    expect(compacted.confidence_score).toBe(78)
    expect(compacted.risk_flags).toEqual(["High volatility"])
    expect(compacted.risks).toEqual(fullDDReport.risks)
    expect(compacted.catalysts).toEqual(fullDDReport.catalysts)
    expect(compacted.summary).toBe(fullDDReport.summary)
  })

  it("handles minimal DDReport with optional fields missing gracefully", () => {
    const minimalReport: DDReport = {
      asset: "ETH",
      category: "layer1",
      timestamp: "2026-08-06T08:00:00Z",
      sections: {
        technical: { score: 50, summary: "Neutral", signals: [] },
        onchain: { score: 50, summary: "Neutral", signals: [] },
        sentiment: { score: 50, summary: "Neutral", signals: [] },
        fundamental: { score: 50, summary: "Neutral", signals: [] },
      },
      risk_flags: [],
    }

    const compacted = compactDDReport(minimalReport)
    expect(compacted.asset).toBe("ETH")
    expect(compacted.sections.technical.score).toBe(50)
    expect(compacted.crossValidation).toBeUndefined()
  })
})
