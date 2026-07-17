import { describe, it, expect } from "vitest"
import { PerspectiveSchema, PerspectiveResultSchema } from "@/lib/agent/planning/types"

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

describe("PerspectiveResultSchema", () => {
  const validResult = {
    perspective: "balance",
    thesis: "BTC has moderate upside potential",
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 65 },
    side: "long",
    leverage_suggested: 5,
    reasoning: "Technical indicators mixed but onchain strong",
    reasoningContent: "Thinking step by step...",
    risk_flags: ["Funding positive"],
  }

  it("validates complete perspective result", () => {
    const result = PerspectiveResultSchema.parse(validResult)
    expect(result.perspective).toBe("balance")
    expect(result.confidence_breakdown.factor_alignment).toBe(70)
    expect(result.risk_flags).toHaveLength(1)
  })

  it("rejects confidence_breakdown factor_alignment outside 0-100", () => {
    expect(() => PerspectiveResultSchema.parse({ ...validResult, confidence_breakdown: { factor_alignment: 200, historical_match: 50, signal_strength: 50 } })).toThrow()
  })

  it("rejects invalid side", () => {
    expect(() => PerspectiveResultSchema.parse({ ...validResult, side: "buy" })).toThrow()
  })
})
