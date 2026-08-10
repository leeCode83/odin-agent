import { describe, it, expect } from "vitest"
import { z } from "zod"
import { buildFeasibilityTools } from "@/lib/agent/planning/tools/feasibility"

const TOOL_NAME = "compute_profit_feasibility"

function getTool() {
  return buildFeasibilityTools().find((t) => t.name === TOOL_NAME)!
}

describe("compute_profit_feasibility", () => {
  it("valid params -> success with computed data", async () => {
    const tool = getTool()
    const params = tool.parameters.parse({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
      atr: 2,
    })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      feasible: true,
      riskRewardRatio: 2,
      breakEvenWinRate: 0.33,
      expectedMovePercent: 2,
      reasons: [
        "R:R 2 meets minimum 1.5",
        "target 5% within TP distance 10%",
        "target 5% within 3x ATR 6%",
      ],
    })
    expect(result.metadata.source).toBe("deterministic")
  })

  it("R:R below minimum -> feasible false", async () => {
    const tool = getTool()
    const params = tool.parameters.parse({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 103,
      side: "long",
      targetProfitPercent: 2,
    })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data.feasible).toBe(false)
    expect(result.data.riskRewardRatio).toBe(0.6)
  })

  it("minRiskRewardRatio param overrides the 1.5 default", async () => {
    const tool = getTool()
    const params = tool.parameters.parse({
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      side: "long",
      targetProfitPercent: 5,
      minRiskRewardRatio: 3,
    })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data.feasible).toBe(false)
    expect(result.data.riskRewardRatio).toBe(2)
  })

  it("rejects invalid side at parse time", () => {
    const tool = getTool()
    expect(() =>
      tool.parameters.parse({
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        side: "sideways",
        targetProfitPercent: 5,
      })
    ).toThrow()
  })

  it("missing required param (takeProfit) fails parse", () => {
    const tool = getTool()
    expect(() =>
      tool.parameters.parse({
        entryPrice: 100,
        stopLoss: 95,
        side: "long",
        targetProfitPercent: 5,
      })
    ).toThrow()
  })
})

describe("buildFeasibilityTools", () => {
  it("returns 1 tool with metadata and described params", () => {
    const tools = buildFeasibilityTools()
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME])
    const tool = tools[0]
    expect(tool.description.length).toBeGreaterThan(0)
    expect(typeof tool.execute).toBe("function")
    const shape = (tool.parameters as z.ZodObject<Record<string, z.ZodTypeAny>>).shape
    for (const field of Object.values(shape)) {
      expect(field.description).toBeDefined()
    }
  })
})
