/**
 * @file due-diligence/plan-validator.test.ts
 * @description Unit tests for plan-validator.ts — sanitization of LLM subagent plans.
 * @module due-diligence
 * @layer test
 */

import { describe, it, expect } from "vitest"
import {
  sanitizePlans,
  parsePlanOutput,
  DEFAULT_INSTRUCTIONS,
} from "@/lib/agent/due-diligence/plan-validator"
import type { SubagentPlan } from "@/lib/agent/due-diligence/types"

const validTechnical: SubagentPlan = {
  factor: "technical",
  instruction: "Use get_atr to verify volatility",
  priority: 1,
}

const validOnchain: SubagentPlan = {
  factor: "onchain",
  instruction: "Use get_whale_txns to check whale movements",
  priority: 2,
}

describe("sanitizePlans", () => {
  it("drops items with invalid factor", () => {
    const result = sanitizePlans(
      [validTechnical, { factor: "macro", instruction: "bad", priority: 3 }, validOnchain],
      "plan",
    )
    expect(result).toHaveLength(2)
    expect(result.map((p) => p.factor)).not.toContain("macro")
  })

  it("drops items with empty instruction", () => {
    const result = sanitizePlans(
      [validTechnical, { factor: "sentiment", instruction: "", priority: 3 }],
      "plan",
    )
    expect(result.some((p) => p.factor === "sentiment")).toBe(false)
    expect(result.some((p) => p.factor === "technical")).toBe(true)
  })

  it("appends technical and onchain when missing, without duplicating when present", () => {
    const result = sanitizePlans([{ factor: "sentiment", instruction: "ok", priority: 3 }], "plan")
    expect(result).toHaveLength(3)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toBe(DEFAULT_INSTRUCTIONS.technical)
    expect(result[0].priority).toBe(1)
    expect(result[1].factor).toBe("onchain")
    expect(result[1].instruction).toBe(DEFAULT_INSTRUCTIONS.onchain)
    expect(result[1].priority).toBe(2)
    expect(result[2].factor).toBe("sentiment")

    const withBoth = sanitizePlans([validTechnical, validOnchain], "plan")
    expect(withBoth).toHaveLength(2)
    expect(withBoth.filter((p) => p.factor === "technical")).toHaveLength(1)
    expect(withBoth.filter((p) => p.factor === "onchain")).toHaveLength(1)
  })

  it("dedupes same factor keeping the best (lowest) priority", () => {
    const result = sanitizePlans(
      [
        { factor: "technical", instruction: "dup low", priority: 3 },
        validTechnical,
        validOnchain,
      ],
      "plan",
    )
    expect(result.filter((p) => p.factor === "technical")).toHaveLength(1)
    const technical = result.find((p) => p.factor === "technical")
    expect(technical?.instruction).toBe("Use get_atr to verify volatility")
  })

  it("sorts by priority ascending", () => {
    const result = sanitizePlans(
      [
        { factor: "onchain", instruction: "o", priority: 2 },
        { factor: "technical", instruction: "t", priority: 1 },
        { factor: "sentiment", instruction: "s", priority: 3 },
      ],
      "plan",
    )
    expect(result.map((p) => p.priority)).toEqual([1, 2, 3])
  })

    it("returns empty array for empty input (LLM failure stays a failure)", () => {
      const result = sanitizePlans([], "plan")
      expect(result).toEqual([])
    })
})

describe("parsePlanOutput", () => {
  it("returns empty array on unparseable content", () => {
    expect(parsePlanOutput("not json", "plan")).toEqual([])
    expect(parsePlanOutput("null", "plan")).toEqual([])
  })

  it("sanitizes valid JSON content", () => {
    const content = JSON.stringify([
      { factor: "technical", instruction: "Use get_atr", priority: 1 },
      { factor: "invalid_factor", instruction: "bad", priority: 2 },
    ])
    const result = parsePlanOutput(content, "plan")
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result[1].factor).toBe("onchain")
  })

  it("accepts replan log prefix", () => {
    const content = JSON.stringify([{ factor: "technical", instruction: "Re-analyze", priority: 1 }])
    const result = parsePlanOutput(content, "replan")
    expect(result.some((p) => p.factor === "technical")).toBe(true)
    expect(result.some((p) => p.factor === "onchain")).toBe(true)
  })
})
