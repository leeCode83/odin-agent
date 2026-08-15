/**
 * @file __tests__/lib/agent/planning/agent.test.ts
 * @description Tests for the planning swarm orchestrator runPlanningAgent().
 *   Mocks every external dependency (DD agent, LLM aggregate, perspective
 *   subagent, data fetchers, thresholds, graph memory) while keeping the
 *   deterministic layers REAL (buildFixedPerspectives, evaluateConsensus,
 *   autonomyGate, deterministicConfidence, computeTradeNumbers, buildTradePlan)
 *   so the loop integration is tested.
 *
 *   Deterministic reality (Fase 2): the PLAN step is fixed (no LLM plan/rePlan),
 *   and every money number + confidence in the final plan comes from
 *   computeTradeNumbers + deterministicConfidence fed by the mocked tool inputs
 *   (markPrice/ATR/equity/thresholds) — the LLM aggregation mock supplies only
 *   narrative (side/thesis/reasoning). Fixtures are chosen so the deterministic
 *   math stays fully predictable:
 *   - CANDLES: constant-TR 3 candles around price 100 → computeATR = 3.
 *   - fetchMarkPrice → 100 → max feasible target = 3×3% = 9%.
 *   - default target 5% is ATR-feasible (no scaling, feasibility passes).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { runPlanningAgent } from "@/lib/agent/planning/agent"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import type {
  PerspectiveReport,
  PlanningAggregationLlmResult,
  PlanningAgentInput,
} from "@/lib/agent/planning/types"
import type { DDReport } from "@/lib/agent/types"

const aggregateMock = vi.hoisted(() => vi.fn())
const runPerspectiveSubagentMock = vi.hoisted(() => vi.fn())
const buildPlanningToolRegistryMock = vi.hoisted(() => vi.fn())
const fetchUserEquityMock = vi.hoisted(() => vi.fn())
const fetchCandlesForATRMock = vi.hoisted(() => vi.fn())
const fetchMarkPriceMock = vi.hoisted(() => vi.fn())
const computeLeverageMock = vi.hoisted(() => vi.fn())
const getRiskThresholdsMock = vi.hoisted(() => vi.fn())
const envDefaultsMock = vi.hoisted(() => vi.fn())
const recordDecisionMock = vi.hoisted(() => vi.fn())
const queryPerspectivePerformanceMock = vi.hoisted(() => vi.fn())
const queryGraphPatternsMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/agent/planning/llm", () => ({
  aggregate: aggregateMock,
}))
vi.mock("@/lib/agent/planning/subagent", () => ({
  runPerspectiveSubagent: runPerspectiveSubagentMock,
}))
vi.mock("@/lib/agent/planning/tools", () => ({
  buildPlanningToolRegistry: buildPlanningToolRegistryMock,
}))
vi.mock("@/lib/data/hyperliquid", () => ({
  fetchUserEquity: fetchUserEquityMock,
  fetchCandlesForATR: fetchCandlesForATRMock,
  fetchMarkPrice: fetchMarkPriceMock,
}))
vi.mock("@/lib/agent/shared/risk-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/shared/risk-engine")>()
  return { ...actual, computeLeverage: computeLeverageMock }
})
vi.mock("@/lib/db/risk-thresholds", () => ({
  getRiskThresholds: getRiskThresholdsMock,
  envDefaults: envDefaultsMock,
}))
vi.mock("@/lib/db/graph-memory", () => ({
  recordDecision: recordDecisionMock,
  // reason: cold-start default — no history → uniform weights; individual
  // tests override with performance data to exercise dynamic weighting.
  queryPerspectivePerformance: queryPerspectivePerformanceMock,
  queryGraphPatterns: queryGraphPatternsMock,
}))

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
  // reason: 5% is ATR-feasible (max feasible = 3×3% = 9%) → no target scaling on
  // the default happy path; feasibility (RR ≥ 1.5, target ≤ TP distance, target
  // ≤ 3×ATR) passes deterministically.
  targetProfitPercent: 5,
  ddReport: DD_REPORT,
}

const THRESHOLDS = {
  confidence_threshold: 70,
  // reason: sized so the deterministic position (≈2222 USDC) clears the gate.
  max_position_usdc: 5000,
  max_leverage: 10,
  risk_per_trade_percent: 1,
}

// reason: 20 constant-TR candles around price 100 (high 101.5, low 98.5, close
// 100) → true range 3 → computeATR = 3 exactly, so every deterministic number
// below is fully predictable.
const CANDLES = Array.from({ length: 20 }, (_, i) => ({
  timestamp: 1700000000000 + i * 3600_000,
  open: 100,
  high: 101.5,
  low: 98.5,
  close: 100,
  volume: 1000,
}))

// reason: default report carries a bullish signal (strength 70) so the
// deterministic confidence of a unanimous-long swarm is 77:
//   factor_alignment 100 (4 bullish factors) + historical_match 30 (no history)
//   + signal_strength 100 (70 × 1.5 agreement boost) → round(230/3) = 77.
const BULLISH_SIGNALS = [{ name: "bullish momentum", strength: 70, direction: "bullish" as const }]

function makeReport(over: Partial<PerspectiveReport> = {}): PerspectiveReport {
  return {
    perspective: "conservative",
    score: 100,
    confidence: 100,
    side: "long",
    entry_price: 100,
    signals: BULLISH_SIGNALS,
    dataSources: [],
    reasoning: "Bullish momentum",
    iterations: 3,
    conclusion: "Go long",
    errors: [],
    suggested_stop_loss: 95.5,
    suggested_take_profit: 109,
    suggested_position_size_usdc: 2222.22,
    risk_flags: [],
    risk_flags_text: "",
    ...over,
  }
}

function makeAggregation(over: Partial<PlanningAggregationLlmResult> = {}): PlanningAggregationLlmResult {
  return {
    side: "long",
    thesis: "Aggregated thesis",
    reasoning: "Aggregated reasoning",
    risk_flags_text: "",
    consensus_alignment: 80,
    contradictions: [],
    ...over,
  }
}

function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((e) => e)
}

describe("runPlanningAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchUserEquityMock.mockResolvedValue(10000)
    fetchCandlesForATRMock.mockResolvedValue(CANDLES)
    // reason: mark price 100 + ATR 3 → max feasible target = 3×3% = 9% > INPUT
    // target 5% → profit-target scaling stays OFF for the default suite.
    fetchMarkPriceMock.mockResolvedValue(100)
    computeLeverageMock.mockReturnValue(3)
    getRiskThresholdsMock.mockResolvedValue(THRESHOLDS)
    envDefaultsMock.mockReturnValue(THRESHOLDS)
    aggregateMock.mockResolvedValue(makeAggregation())
    runPerspectiveSubagentMock.mockImplementation(
      async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
        makeReport({ perspective })
    )
    buildPlanningToolRegistryMock.mockReturnValue({})
    recordDecisionMock.mockResolvedValue("key-1")
    // reason: cold-start default — no historical performance → uniform weights.
    queryPerspectivePerformanceMock.mockResolvedValue(null)
    queryGraphPatternsMock.mockResolvedValue([])
  })

  describe("step 0 — setup and pre-fetches", () => {
    it("pre-fetches equity, mark price, and ATR once and passes them to the tool registry", async () => {
      await runPlanningAgent(INPUT)

      expect(fetchUserEquityMock).toHaveBeenCalledTimes(1)
      expect(fetchUserEquityMock).toHaveBeenCalledWith("0xabc")
      expect(fetchMarkPriceMock).toHaveBeenCalledTimes(1)
      expect(fetchMarkPriceMock).toHaveBeenCalledWith("BTC")
      expect(fetchCandlesForATRMock).toHaveBeenCalledTimes(1)
      expect(buildPlanningToolRegistryMock).toHaveBeenCalledWith({
        walletAddress: "0xabc",
        userId: "user-1",
        asset: "BTC",
        equity: 10000,
        // reason: pre-fetched once per run — tools serve these from ctx
        // instead of re-fetching (latency fix).
        markPrice: 100,
        atr: 3,
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

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      // reason: 3 of 4 factors usable → deterministic confidence 68 (factor
      // alignment 75 because the failed factor is non-aligned) × 3/4 = 51 →
      // below the 70 confidence threshold → approval path.
      expect(out.status).toBe("approval_required")
      expect(out.report.autonomy_decision).toBe("approve")
      expect(out.report.confidence_score).toBe(51)
      expect(runPerspectiveSubagentMock).toHaveBeenCalled()
    })

    it("penalizes confidence by usable/expected factors (2/4)", async () => {
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

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      // reason: 2 of 4 usable → confidence 60 (alignment 50) × 2/4 = 30 →
      // below the 70 confidence threshold → approval path.
      expect(out.status).toBe("approval_required")
      expect(out.report.confidence_score).toBe(30)
    })

    it("keeps status complete when a penalized DD still clears the autonomy gate", async () => {
      // reason: a full historical match lifts the deterministic confidence to 92
      // (alignment 75 + historical 100 + signal 100) — with a lower confidence
      // threshold the 3/4-penalized score (69) still clears the gate.
      queryGraphPatternsMock.mockResolvedValue([{ pattern: "p", outcome: "profit", frequency: 1 }])
      getRiskThresholdsMock.mockResolvedValue({ ...THRESHOLDS, confidence_threshold: 60 })
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        usableFactorCount: 3,
        sections: { ...DD_REPORT.sections, fundamental: { score: null, summary: null, signals: [] } },
      }

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      expect(out.status).toBe("complete")
      expect(out.report.autonomy_decision).toBe("auto")
      expect(out.report.confidence_score).toBe(69)
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
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

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

  describe("confidence penalty — planned factor count denominator", () => {
    it("applies no penalty when all deployed factors succeeded (2/2 → 1.0)", async () => {
      const twoFactorDD = {
        ...DD_REPORT,
        status: "complete" as const,
        sections: {
          technical: { score: 80, summary: "x", signals: [] },
          onchain: { score: 70, summary: "y", signals: [] },
        },
      }

      const out = await runPlanningAgent({ ...INPUT, ddReport: twoFactorDD })

      // reason: both factors bullish → factor_alignment 100 → confidence 77,
      // no discount despite 2 < 4 factors.
      expect(out.report.confidence_score).toBe(77)
      expect(out.status).toBe("complete")
    })

    it("penalizes when some deployed factors failed (2/4 → 0.5)", async () => {
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        sections: {
          technical: { score: 80, summary: "x", signals: [] },
          onchain: { score: null, summary: null, signals: [] },
          sentiment: { score: 70, summary: "y", signals: [] },
          fundamental: { score: null, summary: null, signals: [] },
        },
      }

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      expect(out.report.confidence_score).toBe(30)
      expect(out.status).toBe("approval_required")
    })

    it("penalizes proportionally for 3 of 4 usable factors (3/4 → 0.75)", async () => {
      const partialDD = {
        ...DD_REPORT,
        status: "partial" as const,
        sections: {
          technical: { score: 80, summary: "x", signals: [] },
          onchain: { score: 70, summary: "y", signals: [] },
          sentiment: { score: 60, summary: "z", signals: [] },
          fundamental: { score: null, summary: null, signals: [] },
        },
      }

      const out = await runPlanningAgent({ ...INPUT, ddReport: partialDD })

      expect(out.report.confidence_score).toBe(51)
      expect(out.status).toBe("approval_required")
    })

    it("falls back to usableFactorCount when sections is empty — no NaN, no crash", async () => {
      const noSectionsDD = {
        ...DD_REPORT,
        status: "complete" as const,
        sections: {},
        usableFactorCount: 2,
      }

      const out = await runPlanningAgent({ ...INPUT, ddReport: noSectionsDD })

      // planned = 0 → falls back to usable = 2 → multiplier 2/2 = 1.0; empty
      // factor scores → alignment 0 → confidence round((0+30+100)/3) = 43.
      expect(out.report.confidence_score).toBe(43)
    })

    it("falls back to usableFactorCount when sections is undefined — no NaN, no crash", async () => {
      const noSectionsDD = {
        ...DD_REPORT,
        status: "complete" as const,
        sections: undefined,
        usableFactorCount: 2,
      } as unknown as DDReport

      const out = await runPlanningAgent({ ...INPUT, ddReport: noSectionsDD })

      // planned = 0 → falls back to usable = 2 → multiplier 2/2 = 1.0
      expect(out.report.confidence_score).toBe(43)
    })

    it("still throws when usableFactorCount is 0 even with deployed sections", async () => {
      const zeroUsableDD = {
        ...DD_REPORT,
        status: "partial" as const,
        sections: {
          technical: { score: null, summary: null, signals: [] },
          onchain: { score: null, summary: null, signals: [] },
        },
      }

      const err = await captureError(runPlanningAgent({ ...INPUT, ddReport: zeroUsableDD }))

      expect(err).toBeInstanceOf(PlanningError)
      expect((err as Error).message).toBe("PLANNING_FAILED")
      expect((err as PlanningError).detail).toMatchObject({ phase: "dd" })
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
      // reason: every number is deterministic computeTradeNumbers output (mark
      // price 100, ATR 3, 1.5×/3.0× SL/TP multipliers).
      expect(plan.entry_price).toBe(100)
      expect(plan.stop_loss).toBe(95.5)
      expect(plan.take_profit).toBe(109)
      // computePositionSize(equity=10000, entry=100, sl=95.5, risk=1%) → 22.2222
      // contracts → 2222.22 USDC
      expect(plan.position_size_usdc).toBe(2222.22)
      expect(plan.position_size_contracts).toBe(22.2222)
      // leverage is the risk engine's deterministic output — fed with the
      // fetched ATR (constant-TR candles → atr 3) and deterministic confidence 77.
      expect(plan.leverage).toBe(3)
      expect(computeLeverageMock).toHaveBeenCalledWith({
        entry: 100,
        atr: 3,
        confidence: 0.77,
        maxLeverage: 10,
        volTarget: 0.05,
      })
      // reason: deterministic confidence, not the LLM's (which is gone).
      expect(plan.confidence_score).toBe(77)
      expect(plan.confidence_breakdown).toEqual({
        factor_alignment: 100,
        historical_match: 30,
        signal_strength: 100,
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
      // reason: bearish DD factors + bearish signals so the deterministic
      // confidence for "short" is 77 (factor_alignment 100, signal_strength 100).
      const bearishDD = {
        ...DD_REPORT,
        sections: {
          technical: { score: 30, summary: "Downtrend", signals: [] },
          onchain: { score: 40, summary: "Distribution", signals: [] },
          sentiment: { score: 35, summary: "Fear", signals: [] },
          fundamental: { score: 20, summary: "Weak", signals: [] },
        },
      }
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({
            perspective,
            side: "short",
            signals: [{ name: "bearish pressure", strength: 70, direction: "bearish" as const }],
          })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "short" }))

      const out = await runPlanningAgent({ ...INPUT, ddReport: bearishDD })

      expect(out.status).toBe("complete")
      expect(out.report.action).toBe("SHORT")
      expect(out.report.side).toBe("short")
      // short geometry with ATR 3: SL above entry, TP below entry.
      expect(out.report.entry_price).toBe(100)
      expect(out.report.stop_loss).toBe(104.5)
      expect(out.report.take_profit).toBe(91)
      expect(out.report.confidence_score).toBe(77)
    })

    it("deploys each planned perspective with the fixed-planner instruction and tool registry", async () => {
      await runPlanningAgent(INPUT)

      expect(runPerspectiveSubagentMock).toHaveBeenCalledTimes(3)
      expect(runPerspectiveSubagentMock).toHaveBeenCalledWith({
        perspective: "conservative",
        instruction: expect.stringContaining("Be skeptical of the DDReport"),
        asset: "BTC",
        ddReport: DD_REPORT,
        targetProfitPercent: 5,
        tools: {},
      })
      expect(runPerspectiveSubagentMock).toHaveBeenCalledWith(
        expect.objectContaining({ perspective: "aggressive" })
      )
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
        confidence: 77,
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
      // reason: mixed factor directions (3 bullish / 1 bearish → factor_alignment
      // 75) + weak signals (strength 40 → 40×1.5 = 60) → deterministic confidence
      // round((75+30+60)/3) = 55 < 70 → approval path.
      const mixedDD = {
        ...DD_REPORT,
        sections: {
          technical: { score: 70, summary: "x", signals: [] },
          onchain: { score: 40, summary: "y", signals: [] },
          sentiment: { score: 55, summary: "z", signals: [] },
          fundamental: { score: 80, summary: "w", signals: [] },
        },
      }
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({
            perspective,
            signals: [{ name: "weak", strength: 40, direction: "bullish" as const }],
          })
      )

      const out = await runPlanningAgent({ ...INPUT, ddReport: mixedDD })

      expect(out.report.autonomy_decision).toBe("approve")
      expect(out.report.confidence_score).toBe(55)
    })

    it("forces NO_TRADE when the ATR candle fetch fails (no ATR → no trade)", async () => {
      // reason: ATR is a required computeTradeNumbers input — without it the
      // deterministic contract forces no_trade rather than trading on a guess.
      fetchCandlesForATRMock.mockRejectedValue(new Error("hl down"))

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("no_trade")
      expect(out.report.action).toBe("NO_TRADE")
      expect(computeLeverageMock).not.toHaveBeenCalled()
    })
  })

  describe("RE-DEPLOY", () => {
    it("re-deploys the fixed plan and accepts on the second iteration", async () => {
      // reason: iteration 1 — conservative/balance abstain, aggressive sides
      // long strongly → Rule 2 strong-minority RE-DEPLOY; iteration 2 — all
      // three align long → Rule 4 ACCEPT.
      let call = 0
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) => {
          call++
          return call <= 3
            ? perspective === "aggressive"
              ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
              : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
            : makeReport({ perspective })
        }
      )
      aggregateMock.mockResolvedValue(makeAggregation())

      const out = await runPlanningAgent(INPUT)

      expect(out.iterations).toBe(2)
      expect(out.status).toBe("complete")
      // reason: the fixed planner always deploys all 3 perspectives each iteration.
      expect(runPerspectiveSubagentMock).toHaveBeenCalledTimes(6)
    })

    it("passes the full deduped report list (latest per perspective) to aggregate", async () => {
      // reason: 2 no_trade + 1 strong long → Rule 2 strong-minority RE-DEPLOY
      // every iteration → aggregate runs twice before the cap forces acceptance.
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          perspective === "aggressive"
            ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
            : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
      )
      aggregateMock
        .mockResolvedValueOnce(makeAggregation({ side: "no_trade" }))
        .mockResolvedValueOnce(makeAggregation())

      await runPlanningAgent(INPUT)

      expect(aggregateMock).toHaveBeenCalledTimes(2)
      for (const call of aggregateMock.mock.calls) {
        expect((call[0] as Record<string, unknown>).reports).toHaveLength(3)
      }
    })

    it("forces ACCEPT with status partial after 2 re-deploys per perspective", async () => {
      // reason: iteration 1 + 2 both hit Rule 2 strong-minority RE-DEPLOY; the
      // per-perspective cap (2) forces acceptance on iteration 2.
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          perspective === "aggressive"
            ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
            : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      expect(out.iterations).toBe(2)
      expect(out.status).toBe("partial")
      expect(out.report.action).toBe("LONG")
      expect(out.report.entry_price).toBe(100)
      // reason: the L3 override floors confidence at the rescued signal's value.
      expect(out.report.confidence_score).toBe(85)
      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
    })

    it("keeps the previous aggregation and forces accept when aggregation fails on re-deploy", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          perspective === "aggressive"
            ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
            : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
      )
      aggregateMock
        .mockResolvedValueOnce(makeAggregation({ side: "no_trade" }))
        .mockResolvedValueOnce(null)

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(2)
      // reason: numbers come from computeTradeNumbers, not the stale LLM mock.
      expect(out.report.entry_price).toBe(100)
      expect(out.report.action).toBe("LONG")
    })

    it("builds a best-effort plan from reports when aggregation never succeeded", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          perspective === "aggressive"
            ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
            : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
      )
      aggregateMock.mockResolvedValue(null)

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(2)
      expect(out.report.action).toBe("LONG")
      expect(out.report.entry_price).toBe(100)
      expect(out.report.position_size_usdc).toBe(2222.22)
      // reason: no aggregation → no L3 override; deterministic confidence from
      // one bullish signal among three votes: round((100+30+82)/3) = 71.
      expect(out.report.confidence_score).toBe(71)
    })

    it("recovers from an aggregation failure on the first iteration", async () => {
      aggregateMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeAggregation())

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

    it("TASK 2: missing equity forces NO_TRADE via the invalid-price guard instead of throwing", async () => {
      // reason: without equity, computeTradeNumbers returns {no_trade:true} →
      // zero prices on a live side → buildTradePlan's invalid-price guard forces
      // NO_TRADE with the invalid_price_data flag.
      fetchUserEquityMock.mockRejectedValue(new Error("hl down"))

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
          makeReport({ perspective, side: "no_trade", signals: [] })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("no_trade")
      expect(out.iterations).toBe(1)
      const plan = out.report
      expect(plan.action).toBe("NO_TRADE")
      // schema requires side long|short — fall back to "long" for no_trade
      expect(plan.side).toBe("long")
      expect(plan.entry_price).toBe(1)
      expect(plan.stop_loss).toBeCloseTo(0.99, 5)
      expect(plan.take_profit).toBeCloseTo(1.01, 5)
      expect(plan.position_size_usdc).toBe(0)
      expect(plan.position_size_contracts).toBe(0)
      expect(plan.leverage).toBe(1)
      expect(computeLeverageMock).not.toHaveBeenCalled()
      expect(plan.autonomy_decision).toBe("auto")
      // NO_TRADE is now persisted for graph memory learning
      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
    })

    it("uses a placeholder entry of 1 for the no_trade encoding", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "no_trade", signals: [] })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

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
          makeReport({ perspective, score: null, confidence: null, signals: [] })
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

  describe("L3 strong-minority override & L1 dynamic weighting", () => {
    it("rescues the strong minority signal through the forced path (SHORT survives)", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) => {
          if (perspective === "aggressive") {
            return makeReport({ perspective, side: "short", confidence: 85, score: 85, signals: [] })
          }
          return makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
        }
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      // reason: iteration 1 → override → RE-DEPLOY of abstainers; iteration 2
      // hits the per-perspective cap → forced → the override applies to the
      // aggregation: side short, confidence max(85, deterministic) = 85.
      expect(out.iterations).toBe(2)
      expect(out.status).toBe("partial")
      expect(out.report.action).toBe("SHORT")
      expect(out.report.confidence_score).toBe(85)
      expect(out.report.side).toBe("short")
      expect(out.consensus?.overrideRule).toMatchObject({
        applied: true,
        side: "short",
        confidence: 85,
        triggeredBy: "aggressive",
      })
    })

    it("never rescues when profit feasibility fails — NO_TRADE stands", async () => {
      // reason: equity fetch failure → the candidate side's geometry is
      // infeasible (computeTradeNumbers requires equity) → the L3 feasibility
      // gate rejects the rescue → NO_TRADE.
      fetchUserEquityMock.mockRejectedValue(new Error("hl down"))
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) => {
          if (perspective === "aggressive") {
            return makeReport({ perspective, side: "short", confidence: 85, score: 85, signals: [] })
          }
          return makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
        }
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      expect(out.report.action).toBe("NO_TRADE")
      expect(out.consensus?.overrideRule.applied).toBe(false)
    })

    it("derives weights from graph-memory performance history", async () => {
      queryPerspectivePerformanceMock.mockResolvedValue({
        conservative: { correct: 1, total: 10 },
        balance: { correct: 2, total: 10 },
        aggressive: { correct: 9, total: 10 },
      })

      const out = await runPlanningAgent(INPUT)

      expect(queryPerspectivePerformanceMock).toHaveBeenCalledWith("user-1")
      // reason: α = 1 − e^(−10/20) ≈ 0.393; aggressive winRate 0.9 → weight
      // ≈ 0.393×0.9 + 0.607×0.333 ≈ 0.556 — clearly above conservative ≈ 0.241.
      expect(out.consensus?.weights.aggressive).toBeGreaterThan(0.5)
      expect(out.consensus?.weights.aggressive).toBeGreaterThan(
        out.consensus?.weights.conservative ?? 0
      )
      expect(out.status).toBe("complete")
    })

    it("persists the per-perspective breakdown with the decision (Phase 2 feed)", async () => {
      await runPlanningAgent(INPUT)

      expect(recordDecisionMock).toHaveBeenCalledTimes(1)
      const doc = recordDecisionMock.mock.calls[0][0] as Record<string, unknown>
      const breakdown = doc.perspectiveBreakdown as unknown[]
      expect(breakdown).toHaveLength(3)
      expect(breakdown[0]).toMatchObject({ perspective: "conservative", side: "long" })
    })

    it("degrades to uniform weights when history is unavailable", async () => {
      queryPerspectivePerformanceMock.mockRejectedValue(new Error("db down"))

      const out = await runPlanningAgent(INPUT)

      expect(out.consensus?.weights).toEqual({
        conservative: 1 / 3,
        balance: 1 / 3,
        aggressive: 1 / 3,
      })
    })

    it("handles an EMPTY performance record ({} — no decisions yet, production 500 regression)", async () => {
      queryPerspectivePerformanceMock.mockResolvedValue({})

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("complete")
      expect(out.consensus?.weights).toEqual({
        conservative: 1 / 3,
        balance: 1 / 3,
        aggressive: 1 / 3,
      })
    })
  })

  describe("Option B — profit-target scaling & decisionPath", () => {
    it("scales an infeasible target to 3×ATR and requires approval (status approval_required)", async () => {
      // reason: mark price 100, ATR 3 (constant-TR candles) → max feasible
      // target = 3×3% = 9% < INPUT target 50% → scaling engages.
      const out = await runPlanningAgent({ ...INPUT, targetProfitPercent: 50 })

      expect(out.report.profit_target_scaled).toBe(true)
      expect(out.report.profit_target_percent).toBe(9)
      expect(out.report.profit_target_original_percent).toBe(50)
      expect(out.report.autonomy_decision).toBe("approve")
      expect(out.report.risk_flags).toContain("profit_target_scaled_from_50_to_9")
      expect(out.status).toBe("approval_required")
      // reason: the scaled target reaches the swarm LLM calls so feasibility
      // is judged against the achievable target, not the original ask.
      expect(aggregateMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetProfitPercent: 9 })
      )
      expect(runPerspectiveSubagentMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetProfitPercent: 9 })
      )
    })

    it("keeps the user target when it is ATR-feasible (no scaling, no forced approval)", async () => {
      // reason: max feasible target = 9% > INPUT target 5% → no scaling; the
      // happy path keeps autonomy auto (confidence 77 ≥ 70).
      const out = await runPlanningAgent(INPUT)

      expect(out.report.profit_target_scaled).toBeUndefined()
      expect(out.report.autonomy_decision).toBe("auto")
      expect(out.status).toBe("complete")
      expect(out.decisionPath).toBe("consensus")
    })

    it("reports decisionPath forced when the re-deploy cap forces acceptance", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          perspective === "aggressive"
            ? makeReport({ perspective, side: "long", confidence: 85, score: 85 })
            : makeReport({ perspective, side: "no_trade", confidence: 0, score: 0, signals: [] })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      expect(out.status).toBe("partial")
      expect(out.iterations).toBe(2)
      expect(out.decisionPath).toBe("forced")
    })

    it("reports decisionPath no_trade for a unanimous abstention", async () => {
      runPerspectiveSubagentMock.mockImplementation(
        async ({ perspective }: { perspective: PerspectiveReport["perspective"] }) =>
          makeReport({ perspective, side: "no_trade", signals: [] })
      )
      aggregateMock.mockResolvedValue(makeAggregation({ side: "no_trade" }))

      const out = await runPlanningAgent(INPUT)

      expect(out.report.action).toBe("NO_TRADE")
      expect(out.decisionPath).toBe("no_trade")
    })
  })
})
