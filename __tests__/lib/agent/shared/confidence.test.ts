import { describe, it, expect } from "vitest"
import { computeDeterministicConfidence } from "@/lib/agent/shared/confidence"

const clean = {
  totalToolCalls: 5,
  successToolCalls: 5,
  uniqueTools: 3,
  emptyDataCalls: 0,
  transientErrors: 0,
  permanentErrors: 0,
}

describe("computeDeterministicConfidence", () => {
  it("returns 100 for a clean run", () => {
    expect(computeDeterministicConfidence(clean)).toBe(100)
  })

  it("penalizes 20 per permanent error", () => {
    expect(computeDeterministicConfidence({ ...clean, permanentErrors: 2 })).toBe(60)
  })

  it("penalizes 5 per transient error", () => {
    expect(computeDeterministicConfidence({ ...clean, transientErrors: 3 })).toBe(85)
  })

  it("penalizes 10 per empty data call", () => {
    expect(computeDeterministicConfidence({ ...clean, emptyDataCalls: 4 })).toBe(60)
  })

  it("penalizes 15 when unique tools below 2", () => {
    expect(computeDeterministicConfidence({ ...clean, uniqueTools: 1 })).toBe(85)
  })

  it("does not penalize when unique tools is 2 or more", () => {
    expect(computeDeterministicConfidence({ ...clean, uniqueTools: 2 })).toBe(100)
  })

  describe("stopReason penalties", () => {
    it("llm_return adds no penalty", () => {
      expect(computeDeterministicConfidence({ ...clean, stopReason: "llm_return" })).toBe(100)
    })

    it("max_loops penalizes 10", () => {
      expect(computeDeterministicConfidence({ ...clean, stopReason: "max_loops" })).toBe(90)
    })

    it("timeout penalizes 30", () => {
      expect(computeDeterministicConfidence({ ...clean, stopReason: "timeout" })).toBe(70)
    })

    it("circuit_open penalizes 40", () => {
      expect(computeDeterministicConfidence({ ...clean, stopReason: "circuit_open" })).toBe(60)
    })

    it("duplicate penalizes 50", () => {
      expect(computeDeterministicConfidence({ ...clean, stopReason: "duplicate" })).toBe(50)
    })
  })

  it("clamps to 15 floor under heavy penalties", () => {
    expect(
      computeDeterministicConfidence({
        ...clean,
        permanentErrors: 5,
        transientErrors: 5,
        stopReason: "duplicate",
      }),
    ).toBe(15)
  })

  it("clamps at 100 ceiling", () => {
    expect(computeDeterministicConfidence({ ...clean, stopReason: "llm_return" })).toBe(100)
  })

  it("returns floor when no tool calls happened", () => {
    expect(
      computeDeterministicConfidence({
        totalToolCalls: 0,
        successToolCalls: 0,
        uniqueTools: 0,
        emptyDataCalls: 0,
        transientErrors: 0,
        permanentErrors: 0,
      }),
    ).toBe(15)
  })
})
