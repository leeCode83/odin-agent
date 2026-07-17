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
    confidence: 65,
    side: "long",
    leverage: 5,
    reasoning: "Technical indicators mixed but onchain strong",
    reasoningContent: "Thinking step by step...",
    signals: ["RSI neutral", "Funding positive"],
  }

  it("validates complete perspective result", () => {
    const result = PerspectiveResultSchema.parse(validResult)
    expect(result.perspective).toBe("balance")
    expect(result.confidence).toBe(65)
    expect(result.signals).toHaveLength(2)
  })

  it("rejects confidence outside 0-100", () => {
    expect(() => PerspectiveResultSchema.parse({ ...validResult, confidence: 200 })).toThrow()
  })

  it("rejects invalid side", () => {
    expect(() => PerspectiveResultSchema.parse({ ...validResult, side: "buy" })).toThrow()
  })
})
