/**
 * @file __tests__/lib/agent/planning/fixed-planner.test.ts
 * @description Unit tests for the deterministic fixed planner (SA5) — replaces
 *   the LLM PLAN/RE-PLAN step with 3 static perspective templates
 *   parameterized by the DDReport. Zero LLM calls; execution subagents
 *   unchanged.
 */

import { describe, it, expect } from "vitest"
import { buildFixedPerspectives } from "@/lib/agent/planning/fixed-planner"
import type { DDReport } from "@/lib/agent/types"

const baseReport: DDReport = {
  asset: "BTC",
  category: "layer1",
  timestamp: "2026-08-06T08:00:00Z",
  sections: {
    technical: { score: 80, summary: "Bullish momentum", signals: ["RSI"] },
    onchain: { score: 70, summary: "Accumulation", signals: ["Outflow"] },
    sentiment: { score: 60, summary: "Neutral", signals: [] },
    fundamental: { score: null, summary: null, signals: [] },
  },
  risk_flags: ["High volatility"],
  risks: [{ factor: "technical", description: "Resistance at 68k", severity: "medium" }],
}

describe("buildFixedPerspectives", () => {
  it("always returns exactly 3 perspectives in fixed order", () => {
    const plans = buildFixedPerspectives(baseReport)
    expect(plans).toHaveLength(3)
    expect(plans.map((plan) => plan.perspective)).toEqual(["conservative", "balance", "aggressive"])
  })

  it("interpolates the DD asset name into every instruction", () => {
    const plans = buildFixedPerspectives(baseReport)
    for (const plan of plans) {
      expect(plan.instructions).toContain("BTC")
    }
  })

  it("interpolates numeric factor scores and skips null-score factors", () => {
    const plans = buildFixedPerspectives(baseReport)
    for (const plan of plans) {
      expect(plan.instructions).toContain("technical 80")
      expect(plan.instructions).toContain("onchain 70")
      expect(plan.instructions).not.toContain("fundamental 80")
    }
  })

  it("interpolates risk highlights (flags and risk entries) into every instruction", () => {
    const plans = buildFixedPerspectives(baseReport)
    for (const plan of plans) {
      expect(plan.instructions).toContain("High volatility")
      expect(plan.instructions).toContain("Resistance at 68k")
    }
  })

  it("interpolates the category into every instruction", () => {
    const plans = buildFixedPerspectives(baseReport)
    for (const plan of plans) {
      expect(plan.instructions).toContain("layer1")
    }
  })

  it("gives each perspective a distinct risk posture", () => {
    const [conservative, balance, aggressive] = buildFixedPerspectives(baseReport)
    expect(conservative.instructions).toMatch(/skeptic/i)
    expect(aggressive.instructions).toMatch(/trust|momentum/i)
    expect(balance.instructions).not.toBe(conservative.instructions)
    expect(balance.instructions).not.toBe(aggressive.instructions)
    expect(conservative.instructions).not.toBe(aggressive.instructions)
  })

  it("does not crash when optional DD fields are missing", () => {
    const minimal: DDReport = {
      asset: "ETH",
      category: "",
      timestamp: "2026-08-06T08:00:00Z",
      sections: {},
      risk_flags: [],
    }
    const plans = buildFixedPerspectives(minimal)
    expect(plans).toHaveLength(3)
    for (const plan of plans) {
      expect(plan.instructions).toContain("ETH")
      expect(plan.instructions.trim()).not.toBe("")
    }
  })

  it("falls back to a safe score summary when no factor has a numeric score", () => {
    const report: DDReport = {
      ...baseReport,
      sections: {
        technical: { score: null, summary: null, signals: [] },
        onchain: { score: null, summary: null, signals: [] },
      },
    }
    const plans = buildFixedPerspectives(report)
    for (const plan of plans) {
      expect(plan.instructions).toContain("no factor scores available")
    }
  })

  it("falls back to a safe risk summary when no risk data is present", () => {
    const report: DDReport = {
      ...baseReport,
      risk_flags: [],
      risks: [],
    }
    const plans = buildFixedPerspectives(report)
    for (const plan of plans) {
      expect(plan.instructions).toContain("none noted")
    }
  })
})
