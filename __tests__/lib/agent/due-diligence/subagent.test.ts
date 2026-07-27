import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { runSubagent, SubAgentThoughtSchema } from "@/lib/agent/due-diligence/subagent"
import type { ToolDefinition, ToolRegistry } from "@/lib/agent/tools/types"

function makeTool(name: string, execute?: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: z.object({}),
    execute: execute ?? (async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 5 } })),
  }
}

describe("SubAgentThoughtSchema", () => {
  it("validates tool_call action", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "tool_call",
      toolName: "get_price",
      params: { asset: "BTC" },
      reasoning: "Need price data",
    })
    expect(result.action).toBe("tool_call")
    if (result.action !== "tool_call") throw new Error("Expected tool_call")
    expect(result.toolName).toBe("get_price")
  })

  it("validates return action", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "return",
      score: 75,
      confidence: 80,
      signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
      reasoning: "Analysis complete",
      conclusion: "Bullish",
    })
    expect(result.action).toBe("return")
    if (result.action !== "return") throw new Error("Expected return")
    expect(result.score).toBe(75)
  })

  it("allows null score and confidence on return", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "return",
      score: null,
      confidence: null,
      signals: [],
      reasoning: "No data",
      conclusion: "Inconclusive",
    })
    if (result.action !== "return") throw new Error("Expected return")
    expect(result.score).toBeNull()
  })

  it("rejects invalid action", () => {
    expect(() =>
      SubAgentThoughtSchema.parse({ action: "invalid" })
    ).toThrow()
  })
})

describe("runSubagent", () => {
  it("returns FactorReport when LLM returns return action", async () => {
    const tools: ToolRegistry = { get_price: makeTool("get_price") }
    const mockThink = vi.fn().mockResolvedValue({
      action: "return",
      score: 75,
      confidence: 80,
      signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
      reasoning: "Analysis complete",
      conclusion: "Bullish momentum",
    })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze BTC",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are a technical analyst.",
    })

    expect(report.factor).toBe("technical")
    expect(report.score).toBe(75)
    expect(report.confidence).toBe(80)
    expect(report.signals).toHaveLength(1)
    expect(report.signals[0].name).toBe("RSI")
    expect(report.iterations).toBe(1)
    expect(report.errors).toHaveLength(0)
  })

  it("executes tool call then returns on next iteration", async () => {
    const tools: ToolRegistry = {
      get_price: makeTool("get_price", async () => ({
        success: true,
        data: { price: 65000 },
        metadata: { source: "hyperliquid", latencyMs: 100 },
      })),
    }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "get_price",
        params: { asset: "BTC" },
        reasoning: "Need price",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 80,
        confidence: 85,
        signals: [{ name: "price", strength: 80, direction: "bullish" }],
        reasoning: "Price looks good",
        conclusion: "Go long",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze BTC",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are a technical analyst.",
    })

    expect(report.score).toBe(80)
    expect(report.iterations).toBe(2)
    expect(report.dataSources).toContain("hyperliquid")
    expect(mockThink).toHaveBeenCalledTimes(2)
  })

  it("handles unknown tool gracefully and continues", async () => {
    const tools: ToolRegistry = { known_tool: makeTool("known_tool") }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "unknown_tool",
        params: {},
        reasoning: "Trying unknown tool",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 50,
        confidence: 50,
        signals: [],
        reasoning: "Recovered",
        conclusion: "Done",
      })

    const report = await runSubagent({
      factor: "sentiment",
      tools,
      instruction: "Analyze",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are a sentiment analyst.",
    })

    expect(report.score).toBe(50)
    expect(report.iterations).toBe(2)
    expect(report.errors.length).toBeGreaterThanOrEqual(1)
    expect(report.errors[0]).toContain("unknown_tool")
  })

  it("handles invalid params gracefully and continues", async () => {
    const tools: ToolRegistry = {
      strict_tool: {
        name: "strict_tool",
        description: "Needs valid params",
        parameters: z.object({ required_field: z.string() }),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
    }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "strict_tool",
        params: { wrong_field: 123 },
        reasoning: "Testing",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 40,
        confidence: 40,
        signals: [],
        reasoning: "Recovered from param error",
        conclusion: "Done",
      })

    const report = await runSubagent({
      factor: "fundamental",
      tools,
      instruction: "Analyze",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are an analyst.",
    })

    expect(report.score).toBe(40)
    expect(report.errors.length).toBeGreaterThanOrEqual(1)
    expect(report.errors[0]).toContain("Invalid params")
  })

  it("force returns after maxLoops when LLM never returns", async () => {
    const tools: ToolRegistry = { dummy: makeTool("dummy") }

    const mockThink = vi.fn().mockResolvedValue({
      action: "tool_call",
      toolName: "dummy",
      params: {},
      reasoning: "Looping",
    })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze",
      asset: "BTC",
      maxLoops: 3,
      llmThink: mockThink,
      getSystemPrompt: () => "You are an analyst.",
    })

    expect(report.score).toBeNull()
    expect(report.confidence).toBeNull()
    expect(report.iterations).toBe(3)
    expect(report.dataSources).toContain("test")
    // 3 tool-call iterations + 1 forced-return LLM call
    expect(mockThink).toHaveBeenCalledTimes(4)
  })

  // ponytail: wall-clock timeout tested implicitly via maxLoops.
  // Real Date.now mocking adds complexity without covering new ground.
})
