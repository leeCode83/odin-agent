import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import { runPerspectiveSubagent } from "@/lib/agent/planning/subagent"
import type { DDReport } from "@/lib/agent/types"
import type { ToolDefinition, ToolRegistry } from "@/lib/agent/due-diligence/tools/types"
import type { SubAgentThought } from "@/lib/agent/due-diligence/subagent"

const thinkMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SubAgentThought>>())

vi.mock("@/lib/agent/due-diligence/llm", () => ({
  think: thinkMock,
}))

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
  score: 75,
  confidence: 80,
  signals: [{ name: "ATR reasonable", strength: 70, direction: "bullish" }],
  reasoning: "Validated against live market data",
  conclusion: "Go long with tight stop",
  side: "long",
  entry_price: 65000,
  suggested_stop_loss: 62000,
  suggested_take_profit: 71000,
  suggested_position_size_usdc: 1000,
  risk_flags: ["Funding positive"],
}

describe("runPerspectiveSubagent", () => {
  beforeEach(() => {
    thinkMock.mockClear()
  })

  it("maps FactorReport + stashed return extras into a PerspectiveReport", async () => {
    const tools: ToolRegistry = {
      compute_atr: makeTool("compute_atr"),
      get_mark_price: makeTool("get_mark_price", async () => ({
        success: true,
        data: { markPrice: 65000 },
        metadata: { source: "hyperliquid", latencyMs: 5 },
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
    expect(report.score).toBe(75)
    // deterministic confidence: 2 successful calls, 2 unique tools → 100-0
    // (LLM verbalized 80 ignored); entry matches the get_mark_price result so
    // the verifier keeps the trade as-is.
    expect(report.confidence).toBe(100)
    expect(report.side).toBe("long")
    expect(report.entry_price).toBe(65000)
    expect(report.suggested_stop_loss).toBe(62000)
    expect(report.suggested_take_profit).toBe(71000)
    expect(report.suggested_position_size_usdc).toBe(1000)
    expect(report.risk_flags).toEqual(["Funding positive"])
    expect(report.signals).toHaveLength(1)
    expect(report.signals[0].name).toBe("ATR reasonable")
    expect(report.dataSources).toContain("test")
    expect(report.iterations).toBe(3)
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
    }
    thinkMock
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "get_mark_price",
        params: { asset: "BTC" },
        reasoning: "Need mark price",
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
      score: 50,
      confidence: 50,
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
    expect(report.score).toBe(50)
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
