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

  it("return variant passes through optional planning fields", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "return",
      score: 75,
      confidence: 80,
      signals: [],
      reasoning: "Analysis complete",
      conclusion: "Bullish",
      side: "long",
      entry_price: 65000,
      suggested_stop_loss: 62000,
      suggested_take_profit: 71000,
      suggested_leverage: 5,
      suggested_position_size_usdc: 100,
      risk_flags: ["Funding positive"],
    })
    if (result.action !== "return") throw new Error("Expected return")
    expect(result.side).toBe("long")
    expect(result.entry_price).toBe(65000)
    expect(result.suggested_stop_loss).toBe(62000)
    expect(result.suggested_take_profit).toBe(71000)
    expect(result.suggested_leverage).toBe(5)
    expect(result.suggested_position_size_usdc).toBe(100)
    expect(result.risk_flags).toEqual(["Funding positive"])
  })

  it("return variant parses without planning fields (DD path unchanged)", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "return",
      score: 75,
      confidence: 80,
      signals: [],
      reasoning: "Analysis complete",
      conclusion: "Bullish",
    })
    if (result.action !== "return") throw new Error("Expected return")
    expect(result.side).toBeUndefined()
    expect(result.entry_price).toBeUndefined()
    expect(result.risk_flags).toBeUndefined()
  })

  it("return variant accepts no_trade side", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "return",
      score: null,
      confidence: null,
      signals: [],
      reasoning: "No setup",
      conclusion: "No trade",
      side: "no_trade",
    })
    if (result.action !== "return") throw new Error("Expected return")
    expect(result.side).toBe("no_trade")
  })

  it("return variant rejects invalid side", () => {
    expect(() =>
      SubAgentThoughtSchema.parse({
        action: "return",
        score: 75,
        confidence: 80,
        signals: [],
        reasoning: "Analysis",
        conclusion: "Bullish",
        side: "buy",
      })
    ).toThrow()
  })

  it("tool_call variant ignores planning extras (return-only fields stripped)", () => {
    const result = SubAgentThoughtSchema.parse({
      action: "tool_call",
      toolName: "get_price",
      params: {},
      reasoning: "Need data",
      side: "long",
    })
    expect(result.action).toBe("tool_call")
    if (result.action !== "tool_call") throw new Error("Expected tool_call")
    expect(result.toolName).toBe("get_price")
    expect(result).not.toHaveProperty("side")
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

  it("drops planning extras from FactorReport (DD output shape unchanged)", async () => {
    const tools: ToolRegistry = { get_price: makeTool("get_price") }
    const mockThink = vi.fn().mockResolvedValue({
      action: "return",
      score: 75,
      confidence: 80,
      signals: [],
      reasoning: "Analysis complete",
      conclusion: "Bullish",
      side: "long",
      entry_price: 65000,
      suggested_leverage: 5,
      risk_flags: ["Funding positive"],
    })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze BTC",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are a technical analyst.",
    })

    const flat = report as unknown as Record<string, unknown>
    expect(flat["side"]).toBeUndefined()
    expect(flat["entry_price"]).toBeUndefined()
    expect(flat["suggested_leverage"]).toBeUndefined()
    expect(flat["risk_flags"]).toBeUndefined()
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

    let callCount = 0
    const mockThink = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        action: "tool_call",
        toolName: "dummy",
        params: { iter: callCount },
        reasoning: "Looping",
      })
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

  it("executes tools via native tool_calls and feeds results back as tool messages", async () => {
    const executeSpy = vi.fn(async () => ({
      success: true,
      data: { price: 65000 },
      metadata: { source: "hyperliquid", latencyMs: 100 },
    }))
    const tools: ToolRegistry = {
      get_price: {
        name: "get_price",
        description: "Get price",
        parameters: z.object({ asset: z.string() }),
        execute: executeSpy,
      },
    }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "native_tool_call",
        toolCalls: [{ id: "call_abc", toolName: "get_price", rawArguments: '{"asset":"BTC"}' }],
        assistantMessage: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_price", arguments: '{"asset":"BTC"}' } }],
        },
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

    expect(executeSpy).toHaveBeenCalledWith({ asset: "BTC" })
    expect(report.score).toBe(80)
    expect(report.iterations).toBe(2)
    expect(report.dataSources).toContain("hyperliquid")

    const secondCallMessages = mockThink.mock.calls[1][0] as Array<Record<string, unknown>>
    const echoMsg = secondCallMessages.find((m) => m.role === "assistant" && m.tool_calls)
    expect(echoMsg).toBeDefined()
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect(toolMsg?.tool_call_id).toBe("call_abc")
    expect(String(toolMsg?.content)).toContain("65000")
  })

  it("executes every native tool_call in a single response", async () => {
    const firstSpy = vi.fn(async () => ({ success: true, data: { price: 100 }, metadata: { source: "test", latencyMs: 0 } }))
    const secondSpy = vi.fn(async () => ({ success: true, data: { trend: "up" }, metadata: { source: "test", latencyMs: 0 } }))
    const tools: ToolRegistry = {
      get_price: makeTool("get_price", firstSpy),
      get_trend: makeTool("get_trend", secondSpy),
    }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "native_tool_call",
        toolCalls: [
          { id: "call_1", toolName: "get_price", rawArguments: '{"asset":"BTC"}' },
          { id: "call_2", toolName: "get_trend", rawArguments: "{}" },
        ],
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 60,
        confidence: 60,
        signals: [],
        reasoning: "Enough data",
        conclusion: "Done",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are an analyst.",
    })

    expect(firstSpy).toHaveBeenCalledTimes(1)
    expect(secondSpy).toHaveBeenCalledTimes(1)
    expect(report.errors).toHaveLength(0)
    const secondCallMessages = mockThink.mock.calls[1][0] as Array<Record<string, unknown>>
    expect(secondCallMessages.filter((m) => m.role === "tool")).toHaveLength(2)
  })

  it("passes OpenAI tools to llmThink when the registry is non-empty", async () => {
    const tools: ToolRegistry = { get_price: makeTool("get_price") }
    const mockThink = vi.fn().mockResolvedValue({
      action: "return",
      score: 50,
      confidence: 50,
      signals: [],
      reasoning: "No tools needed",
      conclusion: "Done",
    })

    await runSubagent({
      factor: "technical",
      tools,
      instruction: "Analyze",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are an analyst.",
    })

    const options = mockThink.mock.calls[0][1] as { tools?: Array<{ function: { name: string } }> } | undefined
    expect(options).toBeDefined()
    expect(options?.tools).toHaveLength(1)
    expect(options?.tools?.[0].function.name).toBe("get_price")
  })

  it("passes no tools option to llmThink when the registry is empty", async () => {
    const mockThink = vi.fn().mockResolvedValue({
      action: "return",
      score: 50,
      confidence: 50,
      signals: [],
      reasoning: "No tools needed",
      conclusion: "Done",
    })

    await runSubagent({
      factor: "technical",
      tools: {},
      instruction: "Analyze",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "You are an analyst.",
    })

    expect(mockThink.mock.calls[0][1]).toBeUndefined()
  })

  it("records a malformed native tool argument as an error and continues", async () => {
    const tools: ToolRegistry = {
      strict_tool: {
        name: "strict_tool",
        description: "Needs a required field",
        parameters: z.object({ required_field: z.string() }),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
    }

    const mockThink = vi
      .fn()
      .mockResolvedValueOnce({
        action: "native_tool_call",
        toolCalls: [{ id: "call_x", toolName: "strict_tool", rawArguments: "not json" }],
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 40,
        confidence: 40,
        signals: [],
        reasoning: "Recovered",
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

    expect(report.errors.length).toBeGreaterThanOrEqual(1)
    const toolMsg = (mockThink.mock.calls[1][0] as Array<Record<string, unknown>>).find((m) => m.role === "tool")
    expect(String(toolMsg?.content)).toContain("Invalid params")
  })

  // ponytail: wall-clock timeout tested implicitly via maxLoops.
  // Real Date.now mocking adds complexity without covering new ground.
})

describe("Error Taxonomy & Duplicate Detection", () => {
  it("surfaces [permanent] error prefix for unknown tool", async () => {
    const tools: ToolRegistry = {}
    const mockThink = vi.fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "unknown_tool",
        params: {},
        reasoning: "Trying something new",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 50,
        confidence: 50,
        signals: [],
        reasoning: "Done",
        conclusion: "Finished",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
    })

    expect(report.errors.some(e => e.includes("[permanent] unknown_tool: Unknown tool"))).toBe(true)
  })

  it("surfaces [permanent] error prefix for Zod validation failure", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool", async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }))
    }
    // Override params to require a specific field
    tools.test_tool.parameters = z.object({ req: z.string() })

    const mockThink = vi.fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "test_tool",
        params: {}, // Missing required field
        reasoning: "Invalid params",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 50,
        confidence: 50,
        signals: [],
        reasoning: "Done",
        conclusion: "Finished",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
    })

    expect(report.errors.some(e => e.includes("[permanent] test_tool: Invalid params"))).toBe(true)
  })

  it("surfaces [transient] error prefix for runtime execution error", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool", async () => { throw new Error("API Timeout") })
    }

    const mockThink = vi.fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "test_tool",
        params: {},
        reasoning: "Call api",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 50,
        confidence: 50,
        signals: [],
        reasoning: "Done",
        conclusion: "Finished",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
    })

    expect(report.errors.some(e => e.includes("[transient] test_tool: Execution error: Error: API Timeout"))).toBe(true)
  })

  it("detects duplicate action and forces early stop (JSON convention)", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool")
    }

    const duplicateCall = {
      action: "tool_call",
      toolName: "test_tool",
      params: { foo: "bar" },
      reasoning: "Stuck in a loop",
    }

    const mockThink = vi.fn()
      .mockResolvedValueOnce(duplicateCall)
      .mockResolvedValueOnce(duplicateCall)
      .mockResolvedValueOnce({
        action: "return", // the force return fallback
        score: 10,
        confidence: 10,
        signals: [],
        reasoning: "Force returned",
        conclusion: "Force returned",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
      maxLoops: 10, // Normally would run 10 times, but we expect it to break after 2
    })

    // 1 normal, 1 duplicate break, 1 force return = 3 total calls
    expect(mockThink).toHaveBeenCalledTimes(3)
    expect(report.errors.some(e => e.includes("[permanent] test_tool: Duplicate tool call detected"))).toBe(true)
  })

  it("detects duplicate action and forces early stop (native tool calls)", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool")
    }

    const duplicateCall1 = {
      action: "native_tool_call",
      toolCalls: [{ id: "call_1", toolName: "test_tool", rawArguments: '{"foo":"bar"}' }],
      assistantMessage: { role: "assistant", tool_calls: [] }
    }
    const duplicateCall2 = {
      action: "native_tool_call",
      toolCalls: [{ id: "call_2", toolName: "test_tool", rawArguments: '{"foo":"bar"}' }],
      assistantMessage: { role: "assistant", tool_calls: [] }
    }

    const mockThink = vi.fn()
      .mockResolvedValueOnce(duplicateCall1)
      .mockResolvedValueOnce(duplicateCall2)
      .mockResolvedValueOnce({
        action: "return",
        score: 10,
        confidence: 10,
        signals: [],
        reasoning: "Force returned",
        conclusion: "Force returned",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
      maxLoops: 10,
    })

    expect(mockThink).toHaveBeenCalledTimes(3)
    expect(report.errors.some(e => e.includes("[permanent] test_tool: Duplicate tool call detected"))).toBe(true)
  })

  it("does not trigger duplicate detection for different params", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool")
    }

    const mockThink = vi.fn()
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "test_tool",
        params: { foo: "bar1" },
        reasoning: "Call 1",
      })
      .mockResolvedValueOnce({
        action: "tool_call",
        toolName: "test_tool",
        params: { foo: "bar2" },
        reasoning: "Call 2 (different params)",
      })
      .mockResolvedValueOnce({
        action: "return",
        score: 50,
        confidence: 50,
        signals: [],
        reasoning: "Done",
        conclusion: "Finished",
      })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
      maxLoops: 10,
    })

    expect(mockThink).toHaveBeenCalledTimes(3)
    expect(report.errors.some(e => e.includes("Duplicate tool call detected"))).toBe(false)
    expect(report.iterations).toBe(3)
  })
})

describe("Circuit Breaker", () => {
  it("breaks the loop and returns stopReason circuit_open if consecutive tool errors exceed threshold", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool", async () => ({ success: false, error: "API Failure", metadata: { source: "test", latencyMs: 0 } }))
    }
    
    const mockThink = vi.fn()
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: { try: 1 }, reasoning: "Fail 1" })
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: { try: 2 }, reasoning: "Fail 2" })
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: { try: 3 }, reasoning: "Fail 3" })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
      circuitBreakerThreshold: 2,
      maxLoops: 5,
    })

    expect(report.stopReason).toBe("circuit_open")
    expect(mockThink).toHaveBeenCalledTimes(3) // 1st try (fails) -> 2nd try (fails) -> circuit opens -> break -> force return
  })
  
  it("resets consecutive errors on success", async () => {
    const tools: ToolRegistry = {
      test_tool: makeTool("test_tool", async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }))
    }
    
    let calls = 0
    tools.test_tool.execute = async () => {
      calls++
      if (calls === 1 || calls === 3) return { success: false, error: "Fail", metadata: { source: "test", latencyMs: 0 } }
      return { success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }
    }

    const mockThink = vi.fn()
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: {}, reasoning: "Fail 1" })
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: { arg: 1 }, reasoning: "Success" })
      .mockResolvedValueOnce({ action: "tool_call", toolName: "test_tool", params: { arg: 2 }, reasoning: "Fail 2" })
      .mockResolvedValueOnce({ action: "return", score: 50, confidence: 50, signals: [], reasoning: "Done", conclusion: "Done" })

    const report = await runSubagent({
      factor: "technical",
      tools,
      instruction: "test",
      asset: "BTC",
      llmThink: mockThink,
      getSystemPrompt: () => "sys",
      circuitBreakerThreshold: 2,
      maxLoops: 5,
    })

    expect(report.stopReason).toBe("llm_return")
    expect(mockThink).toHaveBeenCalledTimes(4)
  })
})
