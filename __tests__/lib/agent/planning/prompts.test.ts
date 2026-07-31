import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  PERSPECTIVE_SYSTEM_PROMPTS,
  AGGREGATOR_SYSTEM_PROMPT,
  PERSPECTIVE_USER_PROMPT,
  AGGREGATOR_USER_PROMPT,
  makePlanningSystemPrompt,
  PLAN_PROMPT,
  AGGREGATE_PROMPT,
  REPLAN_PROMPT,
} from "@/lib/agent/planning/prompts"
import type { DDReport, GraphPattern } from "@/lib/agent/types"
import type { PerspectiveResult, Perspective } from "@/lib/agent/planning/types"
import type { ToolRegistry } from "@/lib/agent/tools/types"

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "large-cap",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish trend intact", signals: ["RSI > 60", "MA crossover"] },
    onchain: { score: 60, summary: "Steady accumulation", signals: ["Exchange outflows"] },
    sentiment: { score: 55, summary: "Neutral sentiment", signals: ["Funding rate neutral"] },
    fundamental: { score: 80, summary: "Strong fundamentals", signals: ["Hashrate ATH"] },
  },
  aggregated_thesis: "BTC has moderate upside potential",
  confidence_score: 65,
  risk_flags: ["Regulatory uncertainty"],
  errors: [],
}

const mockGraphPatterns: GraphPattern[] = [
  { pattern: "cup-handle", outcome: "bullish", frequency: 3 },
  { pattern: "double-top", outcome: "bearish", frequency: 1 },
]

const mockPerspectiveResults: PerspectiveResult[] = [
  {
    perspective: "conservative" as Perspective,
    thesis: "BTC cautious long",
    confidence_breakdown: { factor_alignment: 45, historical_match: 50, signal_strength: 40 },
    side: "long",
    leverage_suggested: 2,
    reasoning: "Trend ok but weak conviction",
    reasoningContent: "",
    risk_flags: ["Low confidence in trend"],
  },
  {
    perspective: "balance" as Perspective,
    thesis: "BTC moderate long",
    confidence_breakdown: { factor_alignment: 65, historical_match: 60, signal_strength: 70 },
    side: "long",
    leverage_suggested: 5,
    reasoning: "Balance of factors positive",
    reasoningContent: "",
    risk_flags: [],
  },
  {
    perspective: "aggressive" as Perspective,
    thesis: "BTC strong long",
    confidence_breakdown: { factor_alignment: 85, historical_match: 70, signal_strength: 90 },
    side: "long",
    leverage_suggested: 10,
    reasoning: "Strong momentum, breakout pattern",
    reasoningContent: "",
    risk_flags: ["High momentum risk"],
  },
]

describe("PERSPECTIVE_SYSTEM_PROMPTS", () => {
  it("has exactly 3 keys: conservative, balance, aggressive", () => {
    const keys = Object.keys(PERSPECTIVE_SYSTEM_PROMPTS).sort()
    expect(keys).toEqual(["aggressive", "balance", "conservative"])
    expect(keys).toHaveLength(3)
  })

  it.each(["conservative", "balance", "aggressive"] as const)(
    "%s prompt mentions 'Return ONLY valid JSON'",
    (key) => {
      expect(PERSPECTIVE_SYSTEM_PROMPTS[key]).toContain("Return ONLY valid JSON")
    }
  )

  it("conservative prompt contains risk-averse keywords", () => {
    const prompt = PERSPECTIVE_SYSTEM_PROMPTS.conservative
    expect(prompt).toMatch(/risk-averse|capital/i)
  })

  it("aggressive prompt contains aggressive/opportunity keywords", () => {
    const prompt = PERSPECTIVE_SYSTEM_PROMPTS.aggressive
    expect(prompt).toMatch(/aggressive|opportunity|asymmetric/i)
  })
})

describe("AGGREGATOR_SYSTEM_PROMPT", () => {
  it("includes confidence_score and confidence_breakdown", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toContain("confidence_score")
    expect(AGGREGATOR_SYSTEM_PROMPT).toContain("confidence_breakdown")
  })
})

describe("PERSPECTIVE_USER_PROMPT", () => {
  it("returns string containing asset name from ddReport", () => {
    const result = PERSPECTIVE_USER_PROMPT(mockDDReport, mockGraphPatterns)
    expect(result).toContain("BTC")
  })

  it("includes section scores and signals", () => {
    const result = PERSPECTIVE_USER_PROMPT(mockDDReport, mockGraphPatterns)
    expect(result).toContain("70")
    expect(result).toContain("RSI > 60")
    expect(result).toContain("Exchange outflows")
  })

  it("includes graph pattern info", () => {
    const result = PERSPECTIVE_USER_PROMPT(mockDDReport, mockGraphPatterns)
    expect(result).toContain("cup-handle")
    expect(result).toContain("bullish")
  })
})

describe("AGGREGATOR_USER_PROMPT", () => {
  it("returns string containing perspective labels", () => {
    const result = AGGREGATOR_USER_PROMPT(mockPerspectiveResults)
    expect(result).toContain("CONSERVATIVE")
    expect(result).toContain("BALANCE")
    expect(result).toContain("AGGRESSIVE")
  })

  it("includes perspective thesis and confidence breakdown", () => {
    const result = AGGREGATOR_USER_PROMPT(mockPerspectiveResults)
    expect(result).toContain("BTC cautious long")
    expect(result).toContain("BTC moderate long")
    expect(result).toContain("BTC strong long")
  })
})

describe("makePlanningSystemPrompt", () => {
  const tools: ToolRegistry = {
    compute_atr: {
      name: "compute_atr",
      description: "Average True Range from candle data",
      parameters: z.object({ asset: z.string(), period: z.number().default(14) }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
    web_search: {
      name: "web_search",
      description: "Search the web for recent news and sentiment",
      parameters: z.object({ query: z.string() }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
  }

  it("returns a function that renders the perspective persona", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("conservative trading analyst")
  })

  it("renders targetProfitPercent and instructs not to re-analyze indicators", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("balance", tools, "Validate")
    expect(prompt).toContain("100%")
    expect(prompt).toContain("do NOT re-analyze technical indicators")
    expect(prompt).toContain("the DDReport already did that")
  })

  it("lists the four tasks from spec 7.2", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 50 })("aggressive", tools, "Validate")
    expect(prompt).toContain("Validating the DDReport's conclusions against current market data")
    expect(prompt).toContain("Computing risk parameters")
    expect(prompt).toContain("external factors")
    expect(prompt).toContain("50%")
  })

  it("renders tool descriptions with parameter schemas via describeZodSchema", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("compute_atr({asset, period})")
    expect(prompt).toContain("Average True Range from candle data")
    expect(prompt).toContain("web_search({query})")
    expect(prompt).toContain("Search the web for recent news and sentiment")
  })

  it("requires at least 2 tools before returning", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("Use at least 2 tools before returning")
  })

  it("describes the return format with planning fields", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain('"action": "return"')
    expect(prompt).toContain('"side": "long" | "short" | "no_trade"')
    expect(prompt).toContain('"entry_price"')
    expect(prompt).toContain('"suggested_stop_loss"')
    expect(prompt).toContain('"suggested_take_profit"')
    expect(prompt).toContain('"suggested_leverage"')
    expect(prompt).toContain('"suggested_position_size_usdc"')
    expect(prompt).toContain('"risk_flags"')
  })

  it("describes the tool_call return format", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain('"action": "tool_call"')
    expect(prompt).toContain('"toolName"')
    expect(prompt).toContain('"params"')
  })

  it("includes the instruction", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Focus on funding regime")
    expect(prompt).toContain("Focus on funding regime")
  })
})

describe("PLAN_PROMPT", () => {
  it("describes orchestrating 3 perspectives with instructions and priorities", () => {
    expect(PLAN_PROMPT).toContain("conservative")
    expect(PLAN_PROMPT).toContain("balance")
    expect(PLAN_PROMPT).toContain("aggressive")
    expect(PLAN_PROMPT).toContain("instruction")
    expect(PLAN_PROMPT).toContain("priority")
    expect(PLAN_PROMPT).toContain("DDReport")
  })

  it("returns a JSON object with a subagents array", () => {
    expect(PLAN_PROMPT).toContain("subagents")
  })
})

describe("AGGREGATE_PROMPT", () => {
  it("includes the 2+ no_trade consensus rule", () => {
    expect(AGGREGATE_PROMPT).toContain("If 2+ perspectives conclude no_trade, final action is no_trade")
  })

  it("includes profit_feasible and no_trade_reason fields", () => {
    expect(AGGREGATE_PROMPT).toContain("profit_feasible")
    expect(AGGREGATE_PROMPT).toContain("no_trade_reason")
  })

  it("includes consensus and contradiction fields", () => {
    expect(AGGREGATE_PROMPT).toContain("consensus_alignment")
    expect(AGGREGATE_PROMPT).toContain("contradictions")
  })

  it("includes final plan parameters", () => {
    expect(AGGREGATE_PROMPT).toContain("entry_price")
    expect(AGGREGATE_PROMPT).toContain("stop_loss")
    expect(AGGREGATE_PROMPT).toContain("take_profit")
    expect(AGGREGATE_PROMPT).toContain("position_size_usdc")
    expect(AGGREGATE_PROMPT).toContain("leverage_suggested")
  })
})

describe("REPLAN_PROMPT", () => {
  it("targets low-consensus perspectives with past reports", () => {
    expect(REPLAN_PROMPT).toMatch(/low-consensus|low consensus/i)
    expect(REPLAN_PROMPT).toMatch(/previous reports|past reports/i)
  })

  it("asks for targeted new instructions with priorities", () => {
    expect(REPLAN_PROMPT).toContain("instruction")
    expect(REPLAN_PROMPT).toContain("priority")
    expect(REPLAN_PROMPT).toContain("perspective")
  })
})
