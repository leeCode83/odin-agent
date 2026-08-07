/**
 * @file __tests__/lib/agent/planning/agent.test.ts
 * @description Tests for the planning swarm orchestrator runPlanningAgent().
 *   Mocks every external dependency (DD agent, LLM plan/rePlan/aggregate,
 *   perspective subagent, data fetchers, thresholds, graph memory) while
 *   keeping the deterministic layers REAL (evaluateConsensus, autonomyGate,
 *   computePositionSize, TradePlanSchema) so the loop integration is tested.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { runPlanningAgent } from "@/lib/agent/planning/agent"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import type {
  PerspectiveReport,
  PlanningAggregationResult,
  PlanningSubagentPlan,
  PlanningAgentInput,
} from "@/lib/agent/planning/types"
import type { DDReport } from "@/lib/agent/types"

const getCategoryMock = vi.hoisted(() => vi.fn())
const planMock = vi.hoisted(() => vi.fn())
const rePlanMock = vi.hoisted(() => vi.fn())
const aggregateMock = vi.hoisted(() => vi.fn())
const runPerspectiveSubagentMock = vi.hoisted(() => vi.fn())
const buildPlanningToolRegistryMock = vi.hoisted(() => vi.fn())
const fetchUserEquityMock = vi.hoisted(() => vi.fn())
const getRiskThresholdsMock = vi.hoisted(() => vi.fn())
const envDefaultsMock = vi.hoisted(() => vi.fn())
const recordDecisionMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/asset-categories", () => ({ getCategory: getCategoryMock }))

vi.mock("@/lib/agent/planning/llm", () => ({
  plan: planMock,
  rePlan: rePlanMock,
  aggregate: aggregateMock,
}))
vi.mock("@/lib/agent/planning/subagent", () => ({
  runPerspectiveSubagent: runPerspectiveSubagentMock,
}))
vi.mock("@/lib/agent/planning/tools", () => ({
  buildPlanningToolRegistry: buildPlanningToolRegistryMock,
}))
vi.mock("@/lib/data/hyperliquid", () => ({ fetchUserEquity: fetchUserEquityMock }))
vi.mock("@/lib/db/risk-thresholds", () => ({
  getRiskThresholds: getRiskThresholdsMock,
  envDefaults: envDefaultsMock,
}))
vi.mock("@/lib/db/graph-memory", () => ({ recordDecision: recordDecisionMock }))

const CATEGORY = { name: "major", activeFactors: ["technical", "onchain", "sentiment", "fundamental"] as const }

const DD_REPORT: DDReport = {
  asset: "BTC",
  category: "major",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish trend intact", signals: ["RSI > 60"] },
    onchain: { score: 60, summary: "Steady accumulation", signals: ["Exchange outflows"] },
    sentiment: { score: 55, summary: "Neutral", signals: [] },
    fundamental: { score: 80, summary: "Strong", signals: [] },
  },
  confidence_score: 65,
  risk_flags: [],
}

const INPUT: PlanningAgentInput = {
  asset: "BTC",
  userId: "user-1",
  walletAddress: "0xabc",
  targetProfitPercent: 100,
  ddReport: DD_REPORT,
}



const FULL_PLAN: PlanningSubagentPlan[] = [
  { perspective: "conservative", instruction: "Validate conservatively", priority: 1 },
  { perspective: "balance", instruction: "Balance the view", priority: 2 },
  { perspective: "aggressive", instruction: "Chase aggressively", priority: 3 },
]

const THRESHOLDS = {
  confidence_threshold: 70,
  max_position_usdc: 500,
  max_leverage: 10,
  risk_per_trade_percent: 1,
}

function makeReport(over: Partial<PerspectiveReport> = {}): PerspectiveReport {
  return {
    perspective: "conservative",
    score: 75,
    confidence: 70,
    side: "long",
    entry_price: 100,
    signals: [],
    dataSources: [],
    reasoning: "Bullish momentum",
    iterations: 3,
    conclusion: "Go long",
    errors: [],
    suggested_stop_loss: 95,
    suggested_take_profit: 110,
    suggested_leverage: 3,
    suggested_position_size_usdc: 500,
    risk_flags: [],
    ...over,
  }
}

function makeAggregation(over: Partial<PlanningAggregationResult> = {}): PlanningAggregationResult {
  return {
    side: "long",
    thesis: "Aggregated thesis",
    reasoning: "Aggregated reasoning",
    confidence_score: 70,
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
    leverage_suggested: 3,
    risk_flags: [],
    consensus_alignment: 80,
    contradictions: [],
    profit_feasible: true,
    entry_price: 100,
    stop_loss: 95,
    take_profit: 110,
    position_size_usdc: 100,
    ...over,
  }
}

function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e) => e)
}

describe("runPlanningAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCategoryMock.mockReturnValue(CATEGORY)
    fetchUserEquityMock.mockResolvedValue(10000)
    getRiskThresholdsMock.mockResolvedValue(THRESHOLDS)
    envDefaultsMock.mockReturnValue(THRESHOLDS)
    planMock.mockResolvedValue(FULL_PLAN)
    rePlanMock.mockResolvedValue(FULL_PLAN)
    aggregateMock.mockResolvedValue(makeAggregation())
    runPerspectiveSubagentMock.mockImplementation(
      async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
        makeReport({ perspective })
    )
    buildPlanningToolRegistryMock.mockReturnValue({})
    recordDecisionMock.mockResolvedValue("key-1")
  })

  describe("step 0 — setup and pre-fetches", () => {
    it("throws PlanningError for an unknown asset", async () => {
      getCategoryMock.mockReturnValue(null)

      const err = await captureError(runPlanningAgent(INPUT))

      expect(err).toBeInstanceOf(PlanningError)
      expect((err as Error).message).toBe("Unknown asset")
    })

    it("pre-fetches equity once and passes it to the tool registry", async () => {
      await runPlanningAgent(INPUT)

      expect(fetchUserEquityMock).toHaveBeenCalledTimes(1)
      expect(fetchUserEquityMock).toHaveBeenCalledWith("0xabc")
      expect(buildPlanningToolRegistryMock).toHaveBeenCalledWith({
        walletAddress: "0xabc",
        userId: "user-1",
        asset: "BTC",
        equity: 10000,
      })
    })

    it("falls back to 0 equity when the equity fetch fails", async () => {
      fetchUserEquityMock.mockRejectedValue(new Error("hl down"))

      await runPlanningAgent(INPUT)

      expect(buildPlanningToolRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({ equity: 0 })
      )
    })
  })

  describe("step 0 — DD report quality gate", () => {
    it("throws PlanningError with phase dd when the DD report status is failed", async () => {
      const err = await captureError(runPlanningAgent({ ...INPUT, ddReport: { ...DD_REPORT, status: "failed" } }))

      expect(err).toBeInstanceOf(PlanningError)
      expect((err as Error).message).toBe("PLANNING_FAILED")
      expect((err as PlanningError).detail).toMatchObject({ phase: "dd" })
      expect(runPerspectiveSubagentMock).not.toHaveBeenCalled()
    })

    it("proceeds with a confidence penalty when the DD report status is partial with usable scores", async () => {
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        usableFactorCount: 3,
        sections: { ...DD_REPORT.sections, fundamental: { score: null, summary: null, signals: [] } },
      }
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 80 }))

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      // 80 * 3/4 = 60 → below the 70 confidence threshold → approval path
      expect(out.status).toBe("approval_required")
      expect(out.report.autonomy_decision).toBe("approve")
      expect(out.report.confidence_score).toBe(60)
      expect(runPerspectiveSubagentMock).toHaveBeenCalled()
    })

    it("penalizes confidence by usable/expected for meme categories (2/3)", async () => {
      getCategoryMock.mockReturnValue({
        name: "meme",
        activeFactors: ["technical", "onchain", "sentiment"] as const,
      })
      const partialDD = {
        ...DD_REPORT,
        category: "meme",
        status: "partial" as const,
        usableFactorCount: 2,
        sections: {
          technical: { score: 80, summary: "x", signals: [] },
          onchain: { score: null, summary: null, signals: [] },
          sentiment: { score: 70, summary: "y", signals: [] },
          fundamental: { score: null, summary: null, signals: [] },
        },
      }
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 80 }))

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      // 80 * 2/3 = 53.33 → 53 → below the 70 confidence threshold → approval path
      expect(out.status).toBe("approval_required")
      expect(out.report.confidence_score).toBe(53)
    })

    it("keeps status complete when a penalized DD still clears the autonomy gate", async () => {
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        usableFactorCount: 3,
        sections: { ...DD_REPORT.sections, fundamental: { score: null, summary: null, signals: [] } },
      }
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 96 }))

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      // 96 * 3/4 = 72 → at/above the 70 threshold → auto
      expect(out.status).toBe("complete")
      expect(out.report.autonomy_decision).toBe("auto")
      expect(out.report.confidence_score).toBe(72)
    })

    it("keeps status no_trade when a partial DD still yields NO_TRADE", async () => {
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        usableFactorCount: 3,
        sections: { ...DD_REPORT.sections, fundamental: { score: null, summary: null, signals: [] } },
      }
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "no_trade" })
      )
      aggregateMock.mockResolvedValue(
        makeAggregation({ side: "no_trade", position_size_usdc: 0, confidence_score: 40, profit_feasible: false })
      )

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      expect(out.status).toBe("no_trade")
      expect(out.report.autonomy_decision).toBe("auto")
    })

    it("throws PlanningError with phase dd when every factor section has a null score", async () => {
      const brokenDD = {
        ...DD_REPORT,
        status: "complete" as const,
        sections: {
          technical: { score: null, summary: null, signals: [] },
          onchain: { score: null, summary: null, signals: [] },
          sentiment: { score: null, summary: null, signals: [] },
          fundamental: { score: null, summary: null, signals: [] },
        },
      }

      const err = await captureError(runPlanningAgent({ ...INPUT, ddReport: brokenDD }))

      expect(err).toBeInstanceOf(PlanningError)
      expect((err as PlanningError).detail).toMatchObject({ phase: "dd" })
      expect(runPerspectiveSubagentMock).not.toHaveBeenCalled()
    })

    it("proceeds when the DD report has usable factor scores", async () => {
      const out = await runPlanningAgent({ ...INPUT, ddReport: { ...DD_REPORT, status: "complete" } })

      expect(out.status).toBe("complete")
    })
  })

  describe("happy path — ACCEPT", () => {
    it("accepts on full consensus and builds a LONG trade plan", async () => {
      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("complete")
      expect(out.iterations).toBe(1)
      expect(out.timing).toMatchObject({
        planMs: expect.any(Number),
        executeMs: expect.any(Number),
        aggregateMs: expect.any(Number),
        evaluateMs: expect.any(Number),
        totalMs: expect.any(Number),
      })

      const plan = out.report
      expect(plan.action).toBe("LONG")
      expect(plan.side).toBe("long")
      expect(plan.entry_price).toBe(100)
      expect(plan.stop_loss).toBe(95)
      expect(plan.take_profit).toBe(110)
      expect(plan.position_size_usdc).toBe(100)
      // computePositionSize(equity=10000, entry=100, sl=95, risk=1%) => 20 contracts
      expect(plan.position_size_contracts).toBe(20)
      expect(plan.leverage).toBe(3)
      expect(plan.confidence_score).toBe(70)
      expect(plan.confidence_breakdown).toEqual({
        factor_alignment: 70,
        historical_match: 60,
        signal_strength: 80,
      })
      expect(plan.thesis).toBe("Aggregated thesis")
      expect(plan.reasoning).toBe("Aggregated reasoning")
      expect(plan.risk_flags).toEqual([])
      expect(plan.graph_patterns_used).toEqual([])
      expect(plan.consensus_alignment).toBe(80)
      expect(plan.processingTimeMs).toBeGreaterThanOrEqual(0)
      expect(plan.iterations).toBe(1)
      expect(plan.autonomy_decision).toBe("auto")
      expect(plan.timestamp).toBeDefined()
    })

    it("maps an all-short consensus to action SHORT", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "short" })
      )
      aggregateMock.mockResolvedValue(
        makeAggregation({
          side: "short",
          entry_price: 200,
          stop_loss: 210,
          take_profit: 180,
          confidence_score: 80,
        })
      )

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("complete")
      expect(out.report.action).toBe("SHORT")
      expect(out.report.side).toBe("short")
      expect(out.report.entry_price).toBe(200)
      expect(out.report.stop_loss).toBe(210)
      expect(out.report.take_profit).toBe(180)
    })

    it("deploys each planned perspective with the tool registry", async () => {
      await runPlanningAgent(INPUT)

      expect(runPerspectiveSubagentMock).toHaveBeenCalledTimes(3)
      expect(runPerspectiveSubagentMock).toHaveBeenCalledWith({
        perspective: "conservative",
        instruction: "Validate conservatively",
        asset: "BTC",
        ddReport: DD_REPORT,
        targetProfitPercent: 100,
        tools: {},
      })
    })

    it("falls back to all 3 perspectives when the initial plan is empty", async () => {
      planMock.mockResolvedValue([])

      await runPlanningAgent(INPUT)

      expect(runPerspectiveSubagentMock).toHaveBeenCalledTimes(3)
      const perspectives = runPerspectiveSubagentMock.mock.calls.map(
        (c) => c[0].perspective as string
      )
      expect([...perspectives].sort()).toEqual(["aggressive", "balance", "conservative"])
    })

    it("persists the decision non-blockingly after ACCEPT", async () => {
      await runPlanningAgent(INPUT)

      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
      const doc = recordDecisionMock.mock.calls[0][0] as Record<string, unknown>
      expect(doc).toMatchObject({
        userId: "user-1",
        asset: "BTC",
        decision: "buy",
        side: "long",
        confidence: 70,
        autonomyDecision: "auto",
      })
      expect((doc.tradePlan as Record<string, unknown>).action).toBe("LONG")
    })

    it("does not fail the run when persistence rejects", async () => {
      recordDecisionMock.mockRejectedValue(new Error("db down"))

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("complete")
    })

    it("runs the Layer 2 gate and returns approve when confidence is below threshold", async () => {
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 60 }))

      const out = await runPlanningAgent(INPUT)

      expect(out.report.autonomy_decision).toBe("approve")
    })
  })

  describe("RE-DEPLOY", () => {
    beforeEach(() => {
      // low per-perspective confidence keeps perspectives in the low-consensus set
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, confidence: 40 })
      )
    })

    it("re-plans low-consensus perspectives and accepts on the second iteration", async () => {
      aggregateMock
        .mockResolvedValueOnce(makeAggregation({ confidence_score: 30, profit_feasible: false }))
        .mockResolvedValueOnce(makeAggregation({ confidence_score: 80, profit_feasible: true }))

      const out = await runPlanningAgent(INPUT)

      expect(out.iterations).toBe(2)
      expect(out.status).toBe("complete")
      expect(rePlanMock).toHaveBeenCalledTimes(1)
      const rePlanArgs = rePlanMock.mock.calls[0][0] as Record<string, unknown>
      expect(rePlanArgs.lowConsensusPerspectives).toEqual(["conservative", "balance", "aggressive"])
      expect(rePlanArgs.ddReport).toBe(DD_REPORT)
      expect(rePlanArgs.targetProfitPercent).toBe(100)
      expect(rePlanArgs.previousReports).toHaveLength(3)
    })

    it("passes the full deduped report list (latest per perspective) to aggregate", async () => {
      aggregateMock
        .mockResolvedValueOnce(makeAggregation({ confidence_score: 30, profit_feasible: false }))
        .mockResolvedValueOnce(makeAggregation({ confidence_score: 80, profit_feasible: true }))

      await runPlanningAgent(INPUT)

      expect(aggregateMock).toHaveBeenCalledTimes(2)
      for (const call of aggregateMock.mock.calls) {
        expect((call[0] as Record<string, unknown>).reports).toHaveLength(3)
      }
    })

    it("forces ACCEPT with status partial after 2 re-deploys per perspective", async () => {
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 30, profit_feasible: false }))

      const out = await runPlanningAgent(INPUT)

      expect(out.iterations).toBe(2)
      expect(out.status).toBe("partial")
      expect(rePlanMock).toHaveBeenCalledTimes(1)
      expect(out.report.action).toBe("LONG")
      expect(out.report.entry_price).toBe(100)
      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
    })

    it("uses generic fallback instructions when rePlan returns empty", async () => {
      rePlanMock.mockResolvedValue([])
      aggregateMock.mockResolvedValue(makeAggregation({ confidence_score: 30, profit_feasible: false }))

      await runPlanningAgent(INPUT)

      const secondIterationCalls = runPerspectiveSubagentMock.mock.calls.slice(3)
      expect(secondIterationCalls).toHaveLength(3)
      expect(secondIterationCalls[0][0].instruction).toContain("conservative")
    })

    it("keeps the previous aggregation and forces accept when aggregation fails on re-deploy", async () => {
      aggregateMock
        .mockResolvedValueOnce(
          makeAggregation({ confidence_score: 30, entry_price: 150, stop_loss: 140, take_profit: 165, profit_feasible: false })
        )
        .mockResolvedValueOnce(null)

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(2)
      expect(out.report.entry_price).toBe(150)
      expect(out.report.stop_loss).toBe(140)
    })

    it("builds a best-effort plan from reports when aggregation never succeeded", async () => {
      aggregateMock.mockResolvedValue(null)

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(2)
      expect(out.report.action).toBe("LONG")
      expect(out.report.entry_price).toBe(100)
      expect(out.report.position_size_usdc).toBe(0)
      expect(out.report.confidence_score).toBe(40)
    })

    it("recovers from an aggregation failure on the first iteration", async () => {
      aggregateMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeAggregation({ confidence_score: 80, profit_feasible: true }))

      const out = await runPlanningAgent(INPUT)

      expect(out.iterations).toBe(2)
      expect(out.status).toBe("complete")
    })
  })

  describe("Error 2 & 3: Planning timeout crash", () => {
    it("TASK 1: fallbackAggregation with empty array forces NO_TRADE instead of throwing on zero prices", async () => {
      vi.stubEnv("PLANNING_LOOP_TIMEOUT_MS", "-1")
      try {
        const out = await runPlanningAgent(INPUT)

        expect(out.status).toBe("no_trade")
        expect(out.report.action).toBe("NO_TRADE")
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it("TASK 2: buildTradePlan with zero prices forces NO_TRADE instead of throwing", async () => {
      // Simulate aggregate returning 0 for prices but NOT side="no_trade"
      aggregateMock.mockResolvedValue(
        makeAggregation({ entry_price: 0, stop_loss: 0, take_profit: 0 })
      )

      // Currently throws ZodError because zero prices fail validation.
      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("no_trade")
      expect(out.report.action).toBe("NO_TRADE")
      expect(out.report.risk_flags).toContain("invalid_price_data")
    })
  })

  describe("fail fast — MAX_LOOPS and loop deadline", () => {
    it("exhausts the loop at MAX_LOOPS 3 (fail fast, was 5) when re-deploys never force accept", async () => {
      // aggregation null + high-confidence same-side reports → rule 6 RE-DEPLOY
      // with an EMPTY low-consensus set → the per-perspective re-deploy cap
      // never fires, so the loop runs to MAX_LOOPS.
      aggregateMock.mockResolvedValue(null)

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(3)
    })

    it("breaks the loop early when the per-iteration deadline is exceeded", async () => {
      // tiny loop budget via env → the deadline must trip at the next
      // iteration start (no fake timers; same pattern as the DD agent)
      vi.stubEnv("PLANNING_LOOP_TIMEOUT_MS", "50")
      try {
        runPerspectiveSubagentMock.mockImplementation(async ({ perspective }) => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return makeReport({ perspective })
        })
        aggregateMock.mockResolvedValue(null)

        const out = await runPlanningAgent(INPUT)

        expect(out.status).toBe("partial")
        expect(out.iterations).toBe(1)
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })

  describe("NO_TRADE", () => {
    it("returns action NO_TRADE with the placeholder encoding when 2+ perspectives abstain", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "no_trade" })
      )
      aggregateMock.mockResolvedValue(
        makeAggregation({ side: "no_trade", position_size_usdc: 0, confidence_score: 40, profit_feasible: false })
      )

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("no_trade")
      expect(out.iterations).toBe(1)
      const plan = out.report
      expect(plan.action).toBe("NO_TRADE")
      // schema requires side long|short — fall back to "long" for no_trade
      expect(plan.side).toBe("long")
      expect(plan.entry_price).toBe(100)
      expect(plan.stop_loss).toBeCloseTo(99, 5)
      expect(plan.take_profit).toBeCloseTo(101, 5)
      expect(plan.position_size_usdc).toBe(0)
      expect(plan.position_size_contracts).toBe(0)
      expect(plan.leverage).toBe(1)
      expect(plan.autonomy_decision).toBe("auto")
      // NO_TRADE is now persisted for graph memory learning
      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
    })

    it("uses a placeholder entry of 1 when the aggregation entry is 0", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "no_trade" })
      )
      aggregateMock.mockResolvedValue(
        makeAggregation({ side: "no_trade", entry_price: 0, position_size_usdc: 0, confidence_score: 40 })
      )

      const out = await runPlanningAgent(INPUT)

      expect(out.report.action).toBe("NO_TRADE")
      expect(out.report.entry_price).toBe(1)
      expect(out.report.stop_loss).toBeCloseTo(0.99, 5)
      expect(out.report.take_profit).toBeCloseTo(1.01, 5)
    })
  })

  describe("FAILED", () => {
    it("throws PlanningError with phase evaluate when all perspectives fail", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, score: null, confidence: null })
      )

      const err = await captureError(runPlanningAgent(INPUT))

      expect(err).toBeInstanceOf(PlanningError)
      expect((err as Error).message).toBe("PLANNING_FAILED")
      expect((err as PlanningError).detail).toMatchObject({ phase: "evaluate" })
      expect((err as PlanningError).detail?.reports).toHaveLength(3)
      expect((err as PlanningError).detail?.ddReport).toBe(DD_REPORT)
      expect(recordDecisionMock).not.toHaveBeenCalled()
    })
  })
})
