/**
 * @file __tests__/lib/agent/due-diligence/agent.test.ts
 * @description Tests for runDDAgent(), computeDeterministicScore() and
 *   buildFinalReport(). Mocks every external dependency (LLM, subagent, tool
 *   registry, graph memory) while keeping the deterministic layers REAL, so
 *   the Plan-Execute-Reflect loop, scoring, and report assembly are tested.
 *   Also covers the fail-fast budgets (max 3 iterations, per-factor 120s,
 *   pipeline timeout, early exit on 2+ failed factors).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/agent/due-diligence/llm", () => ({
  think: vi.fn(),
  plan: vi.fn(),
  rePlan: vi.fn(),
  aggregate: vi.fn(),
}))

vi.mock("@/lib/agent/due-diligence/subagent", () => ({
  runSubagent: vi.fn(),
}))

vi.mock("@/lib/agent/tools/registry", () => ({
  getToolRegistry: vi.fn(() => ({})),
}))

// reason: the real fetchCandleMap hits the network (variable latency) — it is
// only consumed by getToolRegistry (already mocked), so stub it to keep the
// pipeline-timeout test's tiny budget deterministic.
vi.mock("@/lib/agent/tools/technical/candles", () => ({
  fetchCandleMap: vi.fn(() => Promise.resolve(undefined)),
}))

vi.mock("@/lib/db/graph-memory", () => ({
  recordDDReport: vi.fn(() => Promise.resolve("")),
}))

import {
  runDDAgent,
  computeDeterministicScore,
  buildFinalReport,
} from "@/lib/agent/due-diligence/agent"
import { plan, rePlan, aggregate } from "@/lib/agent/due-diligence/llm"
import { runSubagent } from "@/lib/agent/due-diligence/subagent"
import { recordDDReport } from "@/lib/db/graph-memory"
import type { FactorReport, SubagentPlan } from "@/lib/agent/due-diligence/types"

function makeFactorReport(overrides: { factor: string } & Record<string, unknown>): FactorReport {
  return {
    score: 75,
    confidence: 80,
    signals: [{ name: "test-signal", strength: 50, direction: "bullish" }],
    dataSources: ["test-source"],
    reasoning: "Test reasoning from factor analysis",
    iterations: 1,
    conclusion: "Test conclusion",
    errors: [],
    ...overrides,
  } as unknown as FactorReport
}

const defaultAggregationResult = {
  thesis: "Test aggregated thesis",
  crossValidation: {
    pairs: [
      { factorA: "technical", factorB: "onchain", alignment: 80, note: "Aligned" },
      { factorA: "technical", factorB: "sentiment", alignment: 75, note: "Aligned" },
      { factorA: "onchain", factorB: "sentiment", alignment: 85, note: "Aligned" },
    ],
    overallAlignment: 80,
    contradictions: [],
  },
  risks: [{ factor: "technical", description: "Market volatility risk", severity: "medium" }],
  catalysts: [{ factor: "sentiment", description: "Positive news catalyst", impact: "high" }],
  summary: "Overall summary of the analysis",
}

// ----- computeDeterministicScore -----

describe("computeDeterministicScore", () => {
  it("calculates weighted average for score and minimum for confidence", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 80, confidence: 90 }), // weight = 90
      makeFactorReport({ factor: "onchain", score: 60, confidence: 20 }), // weight = 20
      makeFactorReport({ factor: "sentiment", score: 70, confidence: 80 }), // weight = 80
    ]

    const result = computeDeterministicScore(reports)

    // Expected weighted average score: (80*90 + 60*20 + 70*80) / (90 + 20 + 80)
    // = (7200 + 1200 + 5600) / 190
    // = 14000 / 190 = 73.68... rounded to 74
    expect(result.overallScore).toBe(74)
    // Minimum confidence among [90, 20, 80] = 20
    expect(result.overallConfidence).toBe(20)
  })

  it("returns 0,0 when all scores null", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: null, confidence: null }),
      makeFactorReport({ factor: "onchain", score: null, confidence: null }),
    ]

    const result = computeDeterministicScore(reports)

    expect(result.overallScore).toBe(0)
    expect(result.overallConfidence).toBe(0)
  })

  it("returns 0,0 for empty array", () => {
    const result = computeDeterministicScore([])
    expect(result.overallScore).toBe(0)
    expect(result.overallConfidence).toBe(0)
  })

  it("handles all zero confidence", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 80, confidence: 0 }),
      makeFactorReport({ factor: "onchain", score: 60, confidence: 0 }),
    ]
    const result = computeDeterministicScore(reports)
    expect(result.overallScore).toBe(0) // total weight 0 falls back to 0
    expect(result.overallConfidence).toBe(0)
  })

  it("rounds the average score", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 85, confidence: 90 }), // weight = 90
      makeFactorReport({ factor: "onchain", score: 62, confidence: 70 }), // weight = 70
      makeFactorReport({ factor: "sentiment", score: 71, confidence: 80 }), // weight = 80
    ]

    const result = computeDeterministicScore(reports)

    // Expected weighted average score: (85*90 + 62*70 + 71*80) / 240
    // = (7650 + 4340 + 5680) / 240
    // = 17670 / 240 = 73.625... rounded to 74
    expect(result.overallScore).toBe(74)
  })

  it("single factor: confidence equals that factor's confidence", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 85, confidence: 75 }),
    ]

    const result = computeDeterministicScore(reports)

    expect(result.overallScore).toBe(85)
    expect(result.overallConfidence).toBe(75)
  })
})

// ----- buildFinalReport -----

describe("buildFinalReport", () => {
  it("builds complete DDReport with all fields", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 80, confidence: 90 }),
      makeFactorReport({ factor: "onchain", score: 70, confidence: 75 }),
    ]

    const deterministic = { overallScore: 75, overallConfidence: 75 }

    const report = buildFinalReport({
      asset: "BTC",
      category: "major",
      factorReports: reports,
      aggregation: defaultAggregationResult,
      deterministic,
      iterations: 1,
      processingTimeMs: 1500,
      status: "complete",
      errors: [],
    })

    expect(report.asset).toBe("BTC")
    expect(report.category).toBe("major")
    expect(typeof report.timestamp).toBe("string")
    expect(report.overallScore).toBe(75)
    expect(report.overallConfidence).toBe(75)
    expect(report.aggregated_thesis).toBe("Test aggregated thesis")
    expect(report.confidence_score).toBe(75)
    expect(report.status).toBe("complete")
    expect(report.iterations).toBe(1)
    expect(report.crossValidation).toBeDefined()
    expect(report.crossValidation?.overallAlignment).toBe(80)
    expect(report.risks).toHaveLength(1)
    expect(report.risks![0].description).toBe("Market volatility risk")
    expect(report.catalysts).toHaveLength(1)
    expect(report.catalysts![0].description).toBe("Positive news catalyst")
    expect(report.summary).toBe("Overall summary of the analysis")
    expect(report.factorReports).toEqual(reports)
    expect(report.sections).toBeDefined()
    expect(Object.keys(report.sections)).toEqual(["technical", "onchain"])
    expect(report.sections["technical"]!.score).toBe(80)
    expect(report.sections["onchain"]!.summary).toBe("Test conclusion")
    expect(report.risk_flags).toEqual(["Market volatility risk"])
    expect(report.errors).toBeUndefined()
  })

  it("counts usableFactorCount as non-null factor scores (null excluded, 0 included)", () => {
    const reports: FactorReport[] = [
      makeFactorReport({ factor: "technical", score: 80 }),
      makeFactorReport({ factor: "onchain", score: null }),
      makeFactorReport({ factor: "sentiment", score: 0 }),
    ]

    const report = buildFinalReport({
      asset: "BTC",
      category: "major",
      factorReports: reports,
      aggregation: null,
      deterministic: { overallScore: 40, overallConfidence: 40 },
      iterations: 1,
      processingTimeMs: 1000,
      status: "partial",
      errors: [],
    })

    expect(report.usableFactorCount).toBe(2)
  })

  it("includes errors when non-empty", () => {
    const reports: FactorReport[] = [makeFactorReport({ factor: "technical" })]

    const report = buildFinalReport({
      asset: "BTC",
      category: "major",
      factorReports: reports,
      aggregation: null,
      deterministic: { overallScore: 50, overallConfidence: 50 },
      iterations: 3,
      processingTimeMs: 5000,
      status: "partial",
      errors: ["Error 1", "Error 2"],
    })

    expect(report.errors).toEqual(["Error 1", "Error 2"])
    expect(report.status).toBe("partial")
  })

  it("populates defaults when aggregation is null", () => {
    const reports: FactorReport[] = [makeFactorReport({ factor: "technical" })]

    const report = buildFinalReport({
      asset: "BTC",
      category: "major",
      factorReports: reports,
      aggregation: null,
      deterministic: { overallScore: 50, overallConfidence: 50 },
      iterations: 1,
      processingTimeMs: 1000,
      status: "failed",
      errors: [],
    })

    expect(report.crossValidation).toEqual({ pairs: [], overallAlignment: 0, contradictions: [] })
    expect(report.risks).toEqual([])
    expect(report.catalysts).toEqual([])
    expect(report.summary).toBe("")
    expect(report.aggregated_thesis).toBe("")
    expect(report.risk_flags).toEqual([])
  })
})

// ----- runDDAgent -----

describe("runDDAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const defaultCategory = {
    name: "major",
    activeFactors: ["technical", "onchain", "sentiment", "fundamental"],
  }

  it("happy path: accepts on first iteration and returns complete DDReport", async () => {
    const plans: SubagentPlan[] = [
      { factor: "technical", instruction: "Analyze BTC technicals", priority: 1 },
      { factor: "onchain", instruction: "Analyze BTC onchain metrics", priority: 2 },
      { factor: "sentiment", instruction: "Analyze BTC sentiment", priority: 3 },
      { factor: "fundamental", instruction: "Analyze BTC fundamentals", priority: 4 },
    ]

    vi.mocked(plan).mockResolvedValueOnce(plans)
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      makeFactorReport({ factor: factor as string, score: 85, confidence: 90 })
    )
    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      maxLoops: 3,
      userId: "user-1",
      walletAddress: "0x123",
    })

    expect(result.status).toBe("complete")
    expect(result.asset).toBe("BTC")
    expect(result.category).toBe("major")
    expect(result.overallScore).toBe(85)
    expect(result.overallConfidence).toBe(90)
    expect(result.iterations).toBe(1)
    expect(result.factorReports).toHaveLength(4)
    expect(plan).toHaveBeenCalledTimes(1)
    expect(runSubagent).toHaveBeenCalledTimes(4)
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(recordDDReport).toHaveBeenCalledTimes(1)
  })

  it("re-deploy path: round 1 low confidence → re-deploy → round 2 higher confidence → ACCEPT", async () => {
    const plans: SubagentPlan[] = [
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ]

    vi.mocked(plan).mockResolvedValueOnce(plans)

    const rePlans: SubagentPlan[] = [
      { factor: "sentiment", instruction: "Re-analyze sentiment", priority: 1 },
      { factor: "fundamental", instruction: "Re-analyze fundamentals", priority: 2 },
    ]
    vi.mocked(rePlan).mockResolvedValueOnce(rePlans)

    const runSpy = vi.mocked(runSubagent)
    runSpy
      .mockResolvedValueOnce(makeFactorReport({ factor: "technical", score: 80, confidence: 85 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "onchain", score: 75, confidence: 70 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "sentiment", score: 40, confidence: 35 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "fundamental", score: 50, confidence: 45 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "sentiment", score: 75, confidence: 78 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "fundamental", score: 72, confidence: 80 }))

    vi.mocked(aggregate).mockResolvedValue(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      maxLoops: 3,
    })

    expect(result.status).toBe("complete")
    expect(result.iterations).toBe(2)
    expect(result.factorReports).toHaveLength(4)
    // re-deployed factors show updated values, not duplicates
    expect(result.factorReports!.find((r) => r.factor === "sentiment")?.score).toBe(75)
    expect(result.factorReports!.find((r) => r.factor === "fundamental")?.score).toBe(72)
    expect(rePlan).toHaveBeenCalledTimes(1)
    expect(aggregate).toHaveBeenCalledTimes(2)
  })

  it("partial path: returns partial status with mixed results", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
    ])

    vi.mocked(runSubagent)
      .mockResolvedValueOnce(makeFactorReport({ factor: "technical", score: 80, confidence: 85 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "onchain", score: null, confidence: null, errors: ["Failed"] }))

    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical", "onchain"] },
      maxLoops: 3,
    })

    expect(result.status).toBe("partial")
    expect(result.iterations).toBe(1)
  })

  it("failed path: 3+ failed factors returns failed status", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
    ])

    vi.mocked(runSubagent)
      .mockResolvedValueOnce(makeFactorReport({ factor: "technical", score: null, confidence: null, errors: ["Failed"] }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "onchain", score: null, confidence: null, errors: ["Failed"] }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "sentiment", score: null, confidence: null, errors: ["Failed"] }))

    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical", "onchain", "sentiment"] },
      maxLoops: 3,
    })

    expect(result.status).toBe("failed")
    expect(result.iterations).toBe(1)
  })

  it("handles plan failure with fallback", async () => {
    vi.mocked(plan).mockRejectedValueOnce(new Error("LLM down"))
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    )
    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      maxLoops: 2,
    })

    expect(result.status).toBe("complete")
    expect(result.factorReports).toHaveLength(4)
    expect(result.errors!.some((e: string) => e.includes("Initial plan failed"))).toBe(true)
  })

  it("handles aggregation failure gracefully — returns null instead of fake data", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
    ])
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    )
    vi.mocked(aggregate).mockResolvedValueOnce(null)

    const result = await runDDAgent({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical", "onchain", "sentiment"] },
      maxLoops: 2,
    })

    expect(result.status).toBe("partial")
    expect(result.aggregated_thesis).toBe("")
    expect(result.summary).toBe("")
    expect(result.risks).toEqual([])
    expect(result.catalysts).toEqual([])
    expect(result.crossValidation).toEqual({ pairs: [], overallAlignment: 0, contradictions: [] })
    expect(result.errors!.some((e: string) => e.includes("cross-factor analysis unavailable"))).toBe(true)
  })

  it("handles rePlan failure with fallback", async () => {
    const plans: SubagentPlan[] = [
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ]

    vi.mocked(plan).mockResolvedValueOnce(plans)
    vi.mocked(rePlan).mockRejectedValueOnce(new Error("RePlan failed"))

    vi.mocked(runSubagent)
      .mockResolvedValueOnce(makeFactorReport({ factor: "technical", score: 80, confidence: 85 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "onchain", score: 75, confidence: 70 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "sentiment", score: 40, confidence: 35 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "fundamental", score: 50, confidence: 45 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "sentiment", score: 75, confidence: 78 }))
      .mockResolvedValueOnce(makeFactorReport({ factor: "fundamental", score: 72, confidence: 80 }))

    vi.mocked(aggregate).mockResolvedValue(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      maxLoops: 3,
    })

    expect(result.status).toBe("complete")
    expect(result.iterations).toBe(2)
    expect(result.errors!.some((e: string) => e.includes("Re-plan failed"))).toBe(true)
  })

  it("accepts despite cross-validation contradictions (documented as findings)", async () => {
    const plans: SubagentPlan[] = [
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ]

    vi.mocked(plan).mockResolvedValueOnce(plans)
    vi.mocked(rePlan).mockResolvedValue(plans)

    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    )

    vi.mocked(aggregate).mockResolvedValue({
      ...defaultAggregationResult,
      crossValidation: {
        pairs: [{ factorA: "technical", factorB: "sentiment", alignment: 30, note: "Conflict" }],
        overallAlignment: 40,
        contradictions: ["Contradiction detected"],
      },
    })

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      maxLoops: 2,
    })

    // reason: contradictions are findings, not a RE-DEPLOY trigger — the
    // report completes in one iteration with the contradictions documented.
    expect(result.status).toBe("complete")
    expect(result.iterations).toBe(1)
    expect(rePlan).not.toHaveBeenCalled()
    expect(result.crossValidation!.contradictions).toContain("Contradiction detected")
  })

  it("caps re-deploy at 1 round: persistent low confidence returns partial after 2 iterations", async () => {
    const plans: SubagentPlan[] = [
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ]

    vi.mocked(plan).mockResolvedValueOnce(plans)
    vi.mocked(rePlan).mockResolvedValue(plans)

    // 2 high-confidence + 2 low-confidence factors → RE-DEPLOY every iteration;
    // no factor fails → the early-exit must NOT trigger, but the 1-round
    // re-deploy cap must stop the loop after the second iteration.
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      ["sentiment", "fundamental"].includes(factor as string)
        ? makeFactorReport({ factor: factor as string, score: 40, confidence: 35 })
        : makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    )
    vi.mocked(aggregate).mockResolvedValue(defaultAggregationResult)

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
    })

    expect(result.status).toBe("partial")
    expect(result.iterations).toBe(2)
    expect(runSubagent).toHaveBeenCalledTimes(8)
    expect(result.errors!.some((e: string) => e.includes("Re-deploy budget exhausted"))).toBe(true)
  })

  it("passes the 120s per-factor timeout budget to every subagent run", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ])
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) =>
      makeFactorReport({ factor: factor as string, score: 85, confidence: 90 })
    )
    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)

    await runDDAgent({ asset: "BTC", category: defaultCategory })

    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120000 }))
  })

  it("early-exits with a partial report when 2+ factors fail in iteration 1 (no re-deploy)", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ])
    // 2 failed (onchain, sentiment) + 1 low-confidence (fundamental) →
    // evaluateResults says RE-DEPLOY, but the early-exit must return partial
    // instead of deploying further iterations.
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) => {
      if (["onchain", "sentiment"].includes(factor as string)) {
        return makeFactorReport({ factor: factor as string, score: null, confidence: null, errors: ["Failed"] })
      }
      return factor === "fundamental"
        ? makeFactorReport({ factor: factor as string, score: 50, confidence: 45 })
        : makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    })
    vi.mocked(aggregate).mockResolvedValueOnce(defaultAggregationResult)
    vi.mocked(rePlan).mockResolvedValue([])

    const result = await runDDAgent({ asset: "BTC", category: defaultCategory })

    expect(result.status).toBe("partial")
    expect(result.iterations).toBe(1)
    expect(rePlan).not.toHaveBeenCalled()
    expect(runSubagent).toHaveBeenCalledTimes(4)
    // Phase 2 gate compatibility: usable factors still counted correctly
    expect(result.usableFactorCount).toBe(2)
    expect(result.errors!.some((e: string) => e.includes("Early exit"))).toBe(true)
  })

  it("returns partial on pipeline timeout before maxLoops is reached", async () => {
    vi.mocked(plan).mockResolvedValueOnce([
      { factor: "technical", instruction: "Analyze", priority: 1 },
      { factor: "onchain", instruction: "Analyze", priority: 2 },
      { factor: "sentiment", instruction: "Analyze", priority: 3 },
      { factor: "fundamental", instruction: "Analyze", priority: 4 },
    ])
    // 2 high + 2 low confidence → RE-DEPLOY so the loop would continue; the
    // tiny pipeline budget must abort at the next iteration start instead.
    vi.mocked(runSubagent).mockImplementation(async ({ factor }) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return ["sentiment", "fundamental"].includes(factor as string)
        ? makeFactorReport({ factor: factor as string, score: 40, confidence: 35 })
        : makeFactorReport({ factor: factor as string, score: 80, confidence: 85 })
    })
    vi.mocked(aggregate).mockResolvedValue(defaultAggregationResult)
    vi.mocked(rePlan).mockResolvedValue([])

    const result = await runDDAgent({
      asset: "BTC",
      category: defaultCategory,
      pipelineTimeoutMs: 50,
    })

    expect(result.status).toBe("partial")
    expect(result.iterations).toBe(1)
    expect(runSubagent).toHaveBeenCalledTimes(4)
    expect(result.usableFactorCount).toBe(4)
    expect(result.errors!.some((e: string) => e.includes("Pipeline timeout"))).toBe(true)
  })
})
