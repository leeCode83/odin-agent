import { describe, it, expect } from "vitest"
import {
  PERSPECTIVE_SYSTEM_PROMPTS,
  AGGREGATOR_SYSTEM_PROMPT,
  PERSPECTIVE_USER_PROMPT,
  AGGREGATOR_USER_PROMPT,
} from "@/lib/agent/planning/prompts"
import type { DDReport, GraphPattern } from "@/lib/agent/types"
import type { PerspectiveResult, Perspective } from "@/lib/agent/planning/types"

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
