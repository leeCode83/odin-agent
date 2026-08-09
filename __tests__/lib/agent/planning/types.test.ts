import { describe, it, expect, expectTypeOf } from "vitest"
import {
  PerspectiveSchema,
  PerspectiveReportSchema,
  PlanningAgentPlan,
  PlanningAgentInput,
  PlanningAgentOutput,
  PlanningAggregationResult,
  PlanningSubagentPlan,
  ReDeployEntry,
  ConsensusResult,
} from "@/lib/agent/planning/types"
import { TradePlanSchema } from "@/lib/agent/types"
import type { DDReport } from "@/lib/agent/types"

describe("PerspectiveSchema", () => {
  it("accepts conservative", () => {
    expect(PerspectiveSchema.parse("conservative")).toBe("conservative")
  })
  it("accepts balance", () => {
    expect(PerspectiveSchema.parse("balance")).toBe("balance")
  })
  it("accepts aggressive", () => {
    expect(PerspectiveSchema.parse("aggressive")).toBe("aggressive")
  })
  it("rejects invalid perspective", () => {
    expect(() => PerspectiveSchema.parse("moderate")).toThrow()
  })
})

describe("PerspectiveReportSchema", () => {
  const validReport = {
    perspective: "balance",
    score: 75,
    confidence: 80,
    side: "long",
    entry_price: 65000,
    signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
    dataSources: ["hyperliquid"],
    reasoning: "Momentum favors longs",
    iterations: 2,
    conclusion: "Go long",
    errors: [],
    suggested_stop_loss: 62000,
    suggested_take_profit: 71000,
    suggested_position_size_usdc: 100,
    risk_flags: [],
  }

  it("validates a complete perspective report", () => {
    const report = PerspectiveReportSchema.parse(validReport)
    expect(report.perspective).toBe("balance")
    expect(report.score).toBe(75)
    expect(report.side).toBe("long")
    expect(report.signals).toHaveLength(1)
    expect(report.risk_flags).toHaveLength(0)
  })

  it("allows null score and confidence", () => {
    const report = PerspectiveReportSchema.parse({ ...validReport, score: null, confidence: null })
    expect(report.score).toBeNull()
    expect(report.confidence).toBeNull()
  })

  it("accepts no_trade side", () => {
    const report = PerspectiveReportSchema.parse({ ...validReport, side: "no_trade" })
    expect(report.side).toBe("no_trade")
  })

  it("rejects invalid side", () => {
    expect(() => PerspectiveReportSchema.parse({ ...validReport, side: "buy" })).toThrow()
  })

  it("rejects missing required entry_price", () => {
    const { entry_price: _omitted, ...rest } = validReport
    void _omitted
    expect(() => PerspectiveReportSchema.parse(rest)).toThrow()
  })
})

describe("Planning swarm types", () => {
  it("PlanningSubagentPlan has perspective, instruction, priority", () => {
    expectTypeOf<PlanningSubagentPlan>().toEqualTypeOf<{
      perspective: "conservative" | "balance" | "aggressive"
      instruction: string
      priority: number
    }>()
  })

  it("PlanningAgentPlan has subagents and reDeployHistory", () => {
    expectTypeOf<PlanningAgentPlan>().toEqualTypeOf<{
      subagents: PlanningSubagentPlan[]
      reDeployHistory: ReDeployEntry[]
    }>()
  })

  it("ReDeployEntry has perspective, previousConfidence, newInstruction, iteration", () => {
    expectTypeOf<ReDeployEntry>().toEqualTypeOf<{
      perspective: string
      previousConfidence: number | null
      newInstruction: string
      iteration: number
    }>()
  })

  it("ConsensusResult has decision, lowConsensusPerspectives, contradictions, message, noTradeReason, degraded", () => {
    expectTypeOf<ConsensusResult>().toEqualTypeOf<{
      decision: "ACCEPT" | "RE-DEPLOY" | "NO_TRADE" | "FAILED"
      lowConsensusPerspectives: string[]
      contradictions: string[]
      message: string
      noTradeReason?: string
      degraded?: boolean
    }>()
  })

  it("PlanningAgentInput has asset, userId, walletAddress, targetProfitPercent", () => {
    expectTypeOf<PlanningAgentInput>().toEqualTypeOf<{
      asset: string
      userId: string
      walletAddress: string
      targetProfitPercent: number
      ddReport: DDReport
    }>()
  })

  it("PlanningAgentOutput has report, timing, iterations, status", () => {
    expectTypeOf<PlanningAgentOutput>().toEqualTypeOf<{
      report: {
        asset: string
        side: "long" | "short"
        entry_price: number
        position_size_usdc: number
        position_size_contracts: number
        stop_loss: number
        take_profit: number
        leverage: number
        confidence_score: number
        confidence_breakdown: {
          factor_alignment: number
          historical_match: number
          signal_strength: number
        }
        thesis: string
        reasoning: string
        autonomy_decision: "auto" | "approve"
        risk_flags: string[]
        graph_patterns_used: Array<{ pattern: string; outcome: string; frequency: number }>
        timestamp: string
        action: "LONG" | "SHORT" | "NO_TRADE"
        consensus_alignment?: number
        processingTimeMs?: number
        iterations?: number
      }
      timing: { planMs: number; executeMs: number; aggregateMs: number; evaluateMs: number; totalMs: number }
      iterations: number
      status: "complete" | "no_trade" | "partial" | "failed" | "approval_required"
    }>()
  })

  it("PlanningAggregationResult widens side to include no_trade and adds aggregation fields", () => {
    // compile-time check: object must satisfy PlanningAggregationResult,
    // so an over/under-shaped type fails typecheck
    const result: PlanningAggregationResult = {
      side: "no_trade",
      thesis: "Thesis",
      reasoning: "Reasoning",
      confidence_score: 60,
      confidence_breakdown: { factor_alignment: 60, historical_match: 60, signal_strength: 60 },
      risk_flags: [],
      consensus_alignment: 80,
      contradictions: [],
      profit_feasible: true,
      entry_price: 100,
      stop_loss: 90,
      take_profit: 120,
      position_size_usdc: 50,
    }
    expect(result.side).toBe("no_trade")
    expect(result.profit_feasible).toBe(true)
  })
})

describe("TradePlanSchema (swarm extension)", () => {
  const validPlan = {
    asset: "BTC",
    side: "long",
    entry_price: 65000.5,
    position_size_usdc: 100,
    position_size_contracts: 0.0015,
    stop_loss: 62000,
    take_profit: 71000,
    leverage: 5,
    confidence_score: 78,
    confidence_breakdown: { factor_alignment: 80, historical_match: 50, signal_strength: 70 },
    thesis: "BTC bullish",
    reasoning: "Momentum",
    autonomy_decision: "auto",
    risk_flags: [],
    graph_patterns_used: [],
    timestamp: "2026-07-16T10:00:00Z",
  }

  it("defaults action to LONG when omitted (old shape still parses)", () => {
    const result = TradePlanSchema.parse(validPlan)
    expect(result.action).toBe("LONG")
  })

  it("accepts LONG, SHORT, NO_TRADE actions", () => {
    for (const action of ["LONG", "SHORT", "NO_TRADE"] as const) {
      const result = TradePlanSchema.parse({ ...validPlan, action })
      expect(result.action).toBe(action)
    }
  })

  it("rejects invalid action", () => {
    expect(() => TradePlanSchema.parse({ ...validPlan, action: "BUY" })).toThrow()
  })

  it("accepts optional swarm fields when present", () => {
    const result = TradePlanSchema.parse({
      ...validPlan,
      action: "NO_TRADE",
      consensus_alignment: 82,
      processingTimeMs: 1500,
      iterations: 3,
    })
    expect(result.consensus_alignment).toBe(82)
    expect(result.processingTimeMs).toBe(1500)
    expect(result.iterations).toBe(3)
  })

  it("omits optional swarm fields when absent", () => {
    const result = TradePlanSchema.parse(validPlan)
    expect(result.consensus_alignment).toBeUndefined()
    expect(result.processingTimeMs).toBeUndefined()
    expect(result.iterations).toBeUndefined()
  })
})
