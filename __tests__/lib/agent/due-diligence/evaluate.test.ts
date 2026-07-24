import { describe, it, expect } from "vitest"
import { evaluateResults, type EvalResult } from "@/lib/agent/due-diligence/evaluate"
import type { FactorReport, CrossValidation } from "@/lib/agent/due-diligence/types"

function makeReport(overrides: Partial<FactorReport> & { factor: string }): FactorReport {
  return {
    score: null,
    confidence: null,
    signals: [],
    dataSources: [],
    reasoning: "",
    iterations: 1,
    conclusion: "",
    errors: [],
    ...overrides,
  } as FactorReport
}

describe("evaluateResults", () => {
  it("ACCEPT — 3+ factors confidence >= 60, no contradictions", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: 80, confidence: 85 }),
      makeReport({ factor: "onchain", score: 75, confidence: 70 }),
      makeReport({ factor: "sentiment", score: 60, confidence: 65 }),
      makeReport({ factor: "fundamental", score: 50, confidence: 40 }),
    ]

    const result: EvalResult = evaluateResults(reports)

    expect(result.decision).toBe("ACCEPT")
    expect(result.lowConfidenceFactors).toEqual(["fundamental"])
  })

  it("ACCEPT — 3+ high confidence, even with cross-validation empty contradictions", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: 80, confidence: 85 }),
      makeReport({ factor: "onchain", score: 75, confidence: 70 }),
      makeReport({ factor: "sentiment", score: 70, confidence: 65 }),
    ]

    const cv: CrossValidation = {
      pairs: [],
      overallAlignment: 85,
      contradictions: [],
    }

    const result = evaluateResults(reports, cv)
    expect(result.decision).toBe("ACCEPT")
  })

  it("RE-DEPLOY — 1-2 factors low confidence", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: 80, confidence: 85 }),
      makeReport({ factor: "onchain", score: 75, confidence: 70 }),
      makeReport({ factor: "sentiment", score: 40, confidence: 30 }),
      makeReport({ factor: "fundamental", score: 50, confidence: 55 }),
    ]

    const result = evaluateResults(reports)
    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.lowConfidenceFactors).toHaveLength(2)
  })

  it("FAILED — 3+ factors failed (score = null)", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: null, confidence: null }),
      makeReport({ factor: "onchain", score: null, confidence: null }),
      makeReport({ factor: "sentiment", score: null, confidence: null }),
      makeReport({ factor: "fundamental", score: 80, confidence: 85 }),
    ]

    const result = evaluateResults(reports)
    expect(result.decision).toBe("FAILED")
  })

  it("RE-DEPLOY (contradictions) — contradictions found in cross-validation", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: 80, confidence: 85 }),
      makeReport({ factor: "onchain", score: 75, confidence: 70 }),
      makeReport({ factor: "sentiment", score: 70, confidence: 65 }),
    ]

    const cv: CrossValidation = {
      pairs: [
        { factorA: "technical", factorB: "sentiment", alignment: 30, note: "Conflict" },
      ],
      overallAlignment: 40,
      contradictions: ["Technical says bullish, sentiment says bearish"],
    }

    const result = evaluateResults(reports, cv)
    expect(result.decision).toBe("RE-DEPLOY")
    expect(result.contradictions).toHaveLength(1)
  })

  it("PARTIAL — mixed results fallthrough", () => {
    const reports: FactorReport[] = [
      makeReport({ factor: "technical", score: 80, confidence: 85 }),
      makeReport({ factor: "onchain", score: null, confidence: null }),
      makeReport({ factor: "sentiment", score: 70, confidence: 85 }),
    ]

    const result = evaluateResults(reports)
    expect(result.decision).toBe("PARTIAL")
  })
})
