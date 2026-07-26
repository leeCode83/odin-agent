import { describe, it, expect } from "vitest"
import {
  type Factor,
  type FactorReport,
  type SignalEntry,
  type AgentRunState,
  type SubagentPlan,
  type ReDeployEntry,
  type CrossValidation,
  type ValidationPair,
  type RiskEntry,
  type CatalystEntry,
} from "@/lib/agent/due-diligence/types"

describe("Factor", () => {
  it("accepts all four factor values", () => {
    const factors: Factor[] = ["technical", "onchain", "sentiment", "fundamental"]
    expect(factors).toHaveLength(4)
  })
})

describe("SignalEntry", () => {
  it("creates a valid signal entry", () => {
    const signal: SignalEntry = {
      name: "RSI",
      strength: 70,
      direction: "bullish",
    }
    expect(signal.name).toBe("RSI")
    expect(signal.strength).toBe(70)
    expect(signal.direction).toBe("bullish")
  })

  it("accepts bearish direction", () => {
    const signal: SignalEntry = {
      name: "MACD",
      strength: 30,
      direction: "bearish",
    }
    expect(signal.direction).toBe("bearish")
  })

  it("accepts neutral direction", () => {
    const signal: SignalEntry = {
      name: "Volume",
      strength: 50,
      direction: "neutral",
    }
    expect(signal.direction).toBe("neutral")
  })
})

describe("FactorReport", () => {
  it("creates a complete factor report", () => {
    const report: FactorReport = {
      factor: "technical",
      score: 72,
      confidence: 80,
      signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
      dataSources: ["hyperliquid"],
      reasoning: "Strong technical setup",
      iterations: 3,
      conclusion: "Bullish momentum intact",
      errors: [],
    }
    expect(report.factor).toBe("technical")
    expect(report.score).toBe(72)
    expect(report.signals).toHaveLength(1)
    expect(report.errors).toHaveLength(0)
  })

  it("allows null score and confidence", () => {
    const report: FactorReport = {
      factor: "sentiment",
      score: null,
      confidence: null,
      signals: [],
      dataSources: [],
      reasoning: "No data available",
      iterations: 0,
      conclusion: "Insufficient data",
      errors: ["Data feed failed"],
    }
    expect(report.score).toBeNull()
    expect(report.confidence).toBeNull()
    expect(report.errors).toHaveLength(1)
  })
})

describe("AgentRunState", () => {
  it("creates an agent run state", () => {
    const state: AgentRunState = {
      runId: "run-123",
      asset: "BTC",
      status: "in_progress",
      factorReports: {
        technical: null,
        onchain: null,
      },
      iteration: 1,
      errors: [],
      startedAt: Date.now(),
    }
    expect(state.runId).toBe("run-123")
    expect(state.asset).toBe("BTC")
    expect(state.factorReports.technical).toBeNull()
  })
})

describe("SubagentPlan & AgentPlan", () => {
  it("creates subagent plan", () => {
    const plan: SubagentPlan = {
      factor: "technical",
      instruction: "Analyze BTC technical indicators",
      priority: 1,
    }
    expect(plan.factor).toBe("technical")
    expect(plan.priority).toBe(1)
  })

  it("creates agent plan with deployment history", () => {
    const entry: ReDeployEntry = {
      factor: "technical",
      previousConfidence: 60,
      newInstruction: "Re-analyze with more data",
      iteration: 2,
    }
    expect(entry.previousConfidence).toBe(60)
    expect(entry.iteration).toBe(2)
  })
})

describe("ValidationPair & CrossValidation", () => {
  it("creates a validation pair", () => {
    const pair: ValidationPair = {
      factorA: "technical",
      factorB: "onchain",
      alignment: 85,
      note: "Signals align",
    }
    expect(pair.alignment).toBe(85)
  })

  it("creates cross-validation with contradictions", () => {
    const cv: CrossValidation = {
      pairs: [
        { factorA: "technical", factorB: "onchain", alignment: 90, note: "Bullish alignment" },
      ],
      overallAlignment: 90,
      contradictions: ["Sentiment contradicts technical"],
    }
    expect(cv.overallAlignment).toBe(90)
    expect(cv.contradictions).toHaveLength(1)
  })
})

describe("RiskEntry", () => {
  it("creates a risk entry", () => {
    const risk: RiskEntry = {
      factor: "technical",
      description: "RSI overbought",
      severity: "high",
    }
    expect(risk.severity).toBe("high")
  })

  it("accepts all severity levels", () => {
    const low: RiskEntry = { factor: "fundamental", description: "Low liquidity", severity: "low" }
    const med: RiskEntry = { factor: "onchain", description: "Whale movement", severity: "medium" }
    expect(low.severity).toBe("low")
    expect(med.severity).toBe("medium")
  })
})

describe("CatalystEntry", () => {
  it("creates a catalyst entry", () => {
    const catalyst: CatalystEntry = {
      factor: "fundamental",
      description: "ETF inflow",
      impact: "high",
    }
    expect(catalyst.impact).toBe("high")
  })

  it("accepts all impact levels", () => {
    const low: CatalystEntry = { factor: "sentiment", description: "Minor news", impact: "low" }
    const med: CatalystEntry = { factor: "technical", description: "Support level", impact: "medium" }
    expect(low.impact).toBe("low")
    expect(med.impact).toBe("medium")
  })
})
