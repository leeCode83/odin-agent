import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import { runPerspectiveSubagent, TOOL_PRIORITY, orderToolsByPriority } from "@/lib/agent/planning/subagent"
import type { DDReport } from "@/lib/agent/types"
import type { ToolDefinition, ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import type { SubAgentThought } from "@/lib/agent/due-diligence/subagent"

const thinkMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SubAgentThought>>())
const buildDDFactorContextMock = vi.hoisted(() => vi.fn(() => "DDReport coverage focus."))

vi.mock("@/lib/agent/due-diligence/llm", () => ({
  think: thinkMock,
}))

// reason: stub only buildDDFactorContext — makePlanningSystemPrompt stays real so
// the system-prompt assertions keep exercising the actual prompt builder.
vi.mock("@/lib/agent/planning/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/planning/prompts")>()
  return { ...actual, buildDDFactorContext: buildDDFactorContextMock }
})

function makeTool(name: string, execute?: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: z.object({ asset: z.string(), iter: z.number().optional() }),
    execute: execute ?? (async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 5 } })),
  }
}

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "large-cap",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish trend intact", signals: ["RSI > 60"] },
    onchain: { score: 60, summary: "Steady accumulation", signals: ["Exchange outflows"] },
    sentiment: { score: 55, summary: "Neutral", signals: [] },
    fundamental: { score: 80, summary: "Strong", signals: [] },
  },
  confidence_score: 65,
  risk_flags: ["Regulatory uncertainty"],
  errors: [],
}

const returnThoughtWithExtras: SubAgentThought = {
  action: "return",
  signals: [{ name: "ATR reasonable", strength: 70, direction: "bullish" }],
  reasoning: "Validated against live market data",
  conclusion: "Go long with tight stop",
  side: "long",
  risk_flags_text: "Funding positive",
}

describe("runPerspectiveSubagent", () => {
  beforeEach(() => {
    thinkMock.mockClear()
  })

  it("maps FactorReport + stashed return extras into a PerspectiveReport", async () => {
    const tools: ToolRegistry = {
      compute_atr: makeTool("compute_atr", async () => ({
        success: true,
        data: { atr: 2.5 },
        metadata: { source: "hyperliquid", latencyMs: 5 },
      })),
      get_mark_price: makeTool("get_mark_price", async () => ({
        success: true,
        data: { markPrice: 65000 },
        metadata: { source: "hyperliquid", latencyMs: 5 },
      })),
      compute_sltp: makeTool("compute_sltp", async () => ({
        success: true,
        data: { stopLoss: 62000, takeProfit: 71000 },
        metadata: { source: "risk-engine", latencyMs: 5 },
      })),
      compute_position_size: makeTool("compute_position_size", async () => ({
        success: true,
        data: { positionSizeUsdc: 1000, positionSizeContracts: 0.015 },
        metadata: { source: "risk-engine", latencyMs: 5 },
      })),
    }
    thinkMock
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_atr",
        params: { asset: "BTC" },
        reasoning: "Need volatility",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "get_mark_price",
        params: { asset: "BTC" },
        reasoning: "Need mark price",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_sltp",
        params: { asset: "BTC" },
        reasoning: "Need SL/TP",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_position_size",
        params: { asset: "BTC" },
        reasoning: "Need size",
      })
      .mockResolvedValueOnce(returnThoughtWithExtras)

    const report = await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate the DDReport",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(report.perspective).toBe("conservative")
    // deterministic score/confidence: 4 successful calls, 4 unique tools → 100
    // (the LLM's self-assessed values are gone from the schema entirely).
    expect(report.score).toBe(100)
    expect(report.confidence).toBe(100)
    expect(report.side).toBe("long")
    // reason: numbers come from the tool results enforced by the verifier.
    expect(report.entry_price).toBe(65000)
    expect(report.suggested_stop_loss).toBe(62000)
    expect(report.suggested_take_profit).toBe(71000)
    expect(report.suggested_position_size_usdc).toBe(1000)
    // reason: structured flags come from tool data (none in these mocks); the
    // LLM's free-text narrative lands in risk_flags_text.
    expect(report.risk_flags).toEqual([])
    expect(report.risk_flags_text).toBe("Funding positive")
    expect(report.signals).toHaveLength(1)
    expect(report.signals[0].name).toBe("ATR reasonable")
    expect(report.dataSources).toContain("hyperliquid")
    expect(report.iterations).toBe(5)
    expect(report.conclusion).toBe("Go long with tight stop")
    expect(report.errors).toHaveLength(0)
  })

  it("forces no_trade when the LLM proposes a trade without get_mark_price", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    const report = await runPerspectiveSubagent({
      perspective: "aggressive",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(report.side).toBe("no_trade")
    expect(report.entry_price).toBe(0)
    expect(report.suggested_stop_loss).toBe(0)
    expect(report.suggested_take_profit).toBe(0)
    expect(report.suggested_position_size_usdc).toBe(0)
    expect(report.risk_flags).toContain("verifier: entry_price tanpa get_mark_price")
  })

  it("overrides a diverged entry_price to the mark price from get_mark_price", async () => {
    const tools: ToolRegistry = {
      get_mark_price: makeTool("get_mark_price", async () => ({
        success: true,
        data: { markPrice: 66000 },
        metadata: { source: "hyperliquid", latencyMs: 5 },
      })),
      compute_sltp: makeTool("compute_sltp", async () => ({
        success: true,
        data: { stopLoss: 63000, takeProfit: 70000 },
        metadata: { source: "risk-engine", latencyMs: 5 },
      })),
      compute_position_size: makeTool("compute_position_size", async () => ({
        success: true,
        data: { positionSizeUsdc: 1000, positionSizeContracts: 0.015 },
        metadata: { source: "risk-engine", latencyMs: 5 },
      })),
    }
    thinkMock
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "get_mark_price",
        params: { asset: "BTC" },
        reasoning: "Need mark price",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_sltp",
        params: { asset: "BTC" },
        reasoning: "Need SL/TP",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_position_size",
        params: { asset: "BTC" },
        reasoning: "Need size",
      })
      .mockResolvedValueOnce(returnThoughtWithExtras)

    const report = await runPerspectiveSubagent({
      perspective: "balance",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(report.side).toBe("long")
    expect(report.entry_price).toBe(66000)
  })

  it("returns defaults when the return thought has no planning extras", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValueOnce({
      action: "return",
      signals: [],
      reasoning: "No data",
      conclusion: "Inconclusive",
    })

    const report = await runPerspectiveSubagent({
      perspective: "balance",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 50,
      tools,
    })

    expect(report.perspective).toBe("balance")
    expect(report.side).toBe("no_trade")
    expect(report.entry_price).toBe(0)
    expect(report.suggested_stop_loss).toBe(0)
    expect(report.suggested_take_profit).toBe(0)
    expect(report.suggested_position_size_usdc).toBe(0)
    expect(report.risk_flags).toEqual([])
    // reason: unknown factor → deterministic score falls back to the
    // execution-signal confidence (zero tool calls → floor 15).
    expect(report.score).toBe(15)
  })

  it("passes tool_call thoughts through unchanged so tools execute", async () => {
    const executed = vi.fn()
    const tools: ToolRegistry = {
      compute_atr: makeTool("compute_atr", async () => {
        executed()
        return { success: true, data: { atr: 2.5 }, metadata: { source: "hyperliquid", latencyMs: 10 } }
      }),
    }
    thinkMock
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "compute_atr",
        params: { asset: "BTC" },
        reasoning: "Need ATR",
      })
      .mockResolvedValueOnce(returnThoughtWithExtras)

    const report = await runPerspectiveSubagent({
      perspective: "aggressive",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(executed).toHaveBeenCalledTimes(1)
    expect(report.dataSources).toContain("hyperliquid")
  })

  it("injects DDReport and targetProfitPercent into every LLM call", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(thinkMock).toHaveBeenCalled()
    for (const [messages] of thinkMock.mock.calls) {
      const msgs = messages as Array<{ role: string; content: string }>
      const systemPrompt = msgs[0].content
      expect(systemPrompt).toContain("conservative trading analyst")
      expect(systemPrompt).toContain("100%")
      const ddReportMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes("Bullish trend intact")
      )
      expect(ddReportMsg).toBeDefined()
    }
  })

  it("maps defaults when the LLM never returns (loop exhausted)", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    let callCount = 0
    thinkMock.mockImplementation(() => {
      callCount++
      return Promise.resolve({
        action: "tool_call",
        toolName: "compute_atr",
        params: { asset: "BTC", iter: callCount },
        reasoning: "Looping",
      })
    })

    const report = await runPerspectiveSubagent({
      perspective: "balance",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 10,
      tools,
    })

    expect(report.score).toBeNull()
    expect(report.confidence).toBeNull()
    expect(report.side).toBe("no_trade")
    expect(report.entry_price).toBe(0)
    expect(report.risk_flags).toEqual([])
    expect(report.iterations).toBe(5)
    expect(thinkMock).toHaveBeenCalledTimes(6)
  })

  it("injects the degraded-DD note into the system prompt when factorReports are partial", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: {
        ...mockDDReport,
        factorReports: [
          { factor: "technical", score: 70 },
          { factor: "sentiment", score: null },
          { factor: "fundamental", score: 80 },
        ],
      } as unknown as DDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(thinkMock).toHaveBeenCalled()
    const [messages] = thinkMock.mock.calls[0]
    const systemPrompt = (messages as Array<{ role: string; content: string }>)[0].content
    expect(systemPrompt).toContain(
      "Note: DD analysis incomplete — factors sentiment failed. Account for missing data explicitly."
    )
  })

  it("forwards native tool options to think when the registry is non-empty", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    const options = thinkMock.mock.calls[0][1] as
      | { tools?: Array<{ function: { name: string } }> }
      | undefined
    expect(options).toBeDefined()
    expect(options?.tools).toHaveLength(1)
    expect(options?.tools?.[0].function.name).toBe("compute_atr")
  })

  it("calls think without options when the registry is empty", async () => {
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "balance",
      instruction: "Analyze",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools: {},
    })

    expect(thinkMock.mock.calls[0][1]).toBeUndefined()
  })

  it("omits the degraded-DD note when every factorReport scored", async () => {
    const tools: ToolRegistry = { compute_atr: makeTool("compute_atr") }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: {
        ...mockDDReport,
        factorReports: [
          { factor: "technical", score: 70 },
          { factor: "sentiment", score: 55 },
        ],
      } as unknown as DDReport,
      targetProfitPercent: 100,
      tools,
    })

    expect(thinkMock).toHaveBeenCalled()
    const [messages] = thinkMock.mock.calls[0]
    const systemPrompt = (messages as Array<{ role: string; content: string }>)[0].content
    expect(systemPrompt).not.toContain("Note: DD analysis incomplete")
  })
})

describe("TOOL_PRIORITY", () => {
  it("has an entry for every perspective", () => {
    expect(Object.keys(TOOL_PRIORITY).sort()).toEqual(["aggressive", "balance", "conservative"])
    for (const perspective of ["conservative", "balance", "aggressive"] as const) {
      expect(TOOL_PRIORITY[perspective].length).toBeGreaterThan(0)
    }
  })

  it("lists risk-related tool names before market-data ones for conservative", () => {
    const order = TOOL_PRIORITY.conservative
    expect(order.indexOf("compute_atr")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("get_mark_price")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("compute_atr")).toBeLessThan(order.indexOf("get_mark_price"))
    expect(order.indexOf("assess_cascade_risk")).toBeLessThan(order.indexOf("get_mark_price"))
  })

  it("lists market-data tool names before risk-related ones for aggressive", () => {
    const order = TOOL_PRIORITY.aggressive
    expect(order.indexOf("get_mark_price")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("compute_atr")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("get_mark_price")).toBeLessThan(order.indexOf("compute_atr"))
    expect(order.indexOf("web_search")).toBeLessThan(order.indexOf("compute_atr"))
  })
})

describe("orderToolsByPriority", () => {
  it("puts risk-engine tools first for conservative", () => {
    expect(orderToolsByPriority(["get_mark_price", "compute_atr"], "conservative")).toEqual([
      "compute_atr",
      "get_mark_price",
    ])
  })

  it("puts market-data tools first for aggressive", () => {
    expect(orderToolsByPriority(["compute_atr", "get_mark_price", "web_search"], "aggressive")).toEqual([
      "get_mark_price",
      "web_search",
      "compute_atr",
    ])
  })

  it("appends unknown tools after the priority-ordered ones", () => {
    expect(
      orderToolsByPriority(["compute_atr", "compute_profit_feasibility", "get_mark_price"], "conservative")
    ).toEqual(["compute_atr", "get_mark_price", "compute_profit_feasibility"])
  })

  it("skips priority names absent from the given tools", () => {
    expect(orderToolsByPriority(["get_mark_price"], "conservative")).toEqual(["get_mark_price"])
  })

  it("returns an empty array for empty input", () => {
    expect(orderToolsByPriority([], "balance")).toEqual([])
  })
})

describe("runPerspectiveSubagent tool ordering", () => {
  beforeEach(() => {
    thinkMock.mockClear()
  })

  it("reorders the registry by perspective priority before the subagent run", async () => {
    const tools: ToolRegistry = {
      get_mark_price: makeTool("get_mark_price"),
      compute_atr: makeTool("compute_atr"),
    }
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools,
    })

    const options = thinkMock.mock.calls[0][1] as
      | { tools?: Array<{ function: { name: string } }> }
      | undefined
    expect(options?.tools?.map((t) => t.function.name)).toEqual(["compute_atr", "get_mark_price"])
    const [messages] = thinkMock.mock.calls[0]
    const systemPrompt = (messages as Array<{ role: string; content: string }>)[0].content
    expect(systemPrompt.indexOf("- compute_atr(")).toBeLessThan(systemPrompt.indexOf("- get_mark_price("))
  })
})

describe("runPerspectiveSubagent focus context", () => {
  beforeEach(() => {
    buildDDFactorContextMock.mockClear()
  })

  it("passes focus 'risk' to buildDDFactorContext for conservative", async () => {
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "conservative",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools: { compute_atr: makeTool("compute_atr") },
    })

    expect(buildDDFactorContextMock).toHaveBeenCalledWith(expect.anything(), "risk")
  })

  it("passes focus 'market' to buildDDFactorContext for aggressive", async () => {
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "aggressive",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools: { compute_atr: makeTool("compute_atr") },
    })

    expect(buildDDFactorContextMock).toHaveBeenCalledWith(expect.anything(), "market")
  })

  it("calls buildDDFactorContext with a single argument for balance", async () => {
    thinkMock.mockResolvedValue(returnThoughtWithExtras)

    await runPerspectiveSubagent({
      perspective: "balance",
      instruction: "Validate",
      asset: "BTC",
      ddReport: mockDDReport,
      targetProfitPercent: 100,
      tools: { compute_atr: makeTool("compute_atr") },
    })

    expect(buildDDFactorContextMock).toHaveBeenCalledWith(expect.anything())
    expect(buildDDFactorContextMock.mock.calls[0]).toHaveLength(1)
  })
})
