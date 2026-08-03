/**
 * @file llm-rethought.test.ts
 * @description Unit + integration tests for the due-diligence LLM layer: think/plan/rePlan/aggregate
 *   with mocked OpenAI client, plus a real-API DeepSeek json_schema feasibility test (key-gated).
 * @module due-diligence
 * @layer service
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { think, plan, rePlan, aggregate } from "@/lib/agent/due-diligence/llm"
import { REACT_SYSTEM_PROMPT, PLAN_PROMPT, REPLAN_PROMPT, AGGREGATE_PROMPT } from "@/lib/agent/due-diligence/prompts"
import { z } from "zod"

vi.mock("openai", () => {
  const mockCreate = vi.fn()
  return {
    default: vi.fn(function () {
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      }
    }),
  }
})

import OpenAI from "openai"
const mockClient = vi.mocked(new OpenAI({ apiKey: "test" }))
const mockCreate = mockClient.chat.completions.create as ReturnType<typeof vi.fn>

describe("think()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns parsed SubAgentThought on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return",
        score: 75,
        confidence: 80,
        signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
        reasoning: "Analysis complete",
        conclusion: "Bullish momentum",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(75)
      expect(result.confidence).toBe(80)
      expect(result.signals).toHaveLength(1)
      expect(result.signals[0]).toHaveProperty("name", "RSI")
    }
  })

  it("returns parsed tool_call SubAgentThought", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "tool_call",
        toolName: "get_price",
        params: { asset: "BTC" },
        reasoning: "Need price data",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("tool_call")
    if (result.action === "tool_call") {
      expect(result.toolName).toBe("get_price")
      expect(result.params).toEqual({ asset: "BTC" })
    }
  })

  it("returns fallback SubAgentThought when LLM fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
  })

  it("returns fallback on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(0)
    }
  })

  it("returns fallback when retry and repair both fail", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "still not valid json" } }],
    })
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("retries with error feedback when JSON parse fails, then succeeds", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return",
        score: 75,
        confidence: 80,
        signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
        reasoning: "Analysis complete",
        conclusion: "Bullish momentum",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(75)
    }
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryMessages = mockCreate.mock.calls[1][0].messages
    const retryContent = retryMessages[retryMessages.length - 1].content
    expect(retryContent).toContain("Your previous response was not valid JSON")
    expect(retryContent).toContain("Invalid JSON:")
    expect(retryContent).toContain("rawPrefix: not valid json")
  })

  it("salvages a return thought when the LLM emits action 'conclude'", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "conclude",
        score: 70,
        confidence: 65,
        signals: [{ name: "RSI", strength: 70, direction: "bullish" }],
        reasoning: "Analysis complete",
        conclusion: "Bullish momentum",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(70)
      expect(result.conclusion).toBe("Bullish momentum")
    }
  })

  it("defaults a missing conclusion to an empty string on a return thought", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return",
        score: 60,
        confidence: 55,
        signals: [],
        reasoning: "Analysis complete",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(60)
      expect(result.conclusion).toBe("")
    }
  })

  it("defaults a null action to return and keeps the analysis", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: null,
        score: 62,
        confidence: 58,
        signals: [],
        reasoning: "Analysis complete",
        conclusion: "Neutral",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(62)
      expect(result.conclusion).toBe("Neutral")
    }
  })

  it("defaults an empty action string to return", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "",
        score: 55,
        confidence: 50,
        signals: [],
        reasoning: "Analysis complete",
        conclusion: "Neutral",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
  })

  it("defaults an unknown action value to return", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "EXTRACT",
        score: 66,
        confidence: 60,
        signals: [],
        reasoning: "Analysis complete",
        conclusion: "Bullish",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(66)
    }
  })

  it("appends the JSON-only instruction with schema fields to the user message", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return", score: 50, confidence: 50, signals: [], reasoning: "ok", conclusion: "ok",
      }) } }],
    })

    await think([{ role: "user", content: "test" }])

    const sentMessages = mockCreate.mock.calls[0][0].messages
    const userContent = sentMessages.find((m: { role: string }) => m.role === "user").content
    expect(userContent).toContain("Respond ONLY with valid JSON")
    expect(userContent).toContain("No markdown, no code fences")
    expect(userContent).toContain("```json")
    for (const field of ["action", "score", "confidence", "signals", "reasoning", "conclusion", "toolName", "params"]) {
      expect(userContent).toContain(field)
    }
  })

  it("maps the call_tool alias to a tool_call", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "call_tool",
        toolName: "get_price",
        params: { asset: "BTC" },
        reasoning: "Need price",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("tool_call")
  })
})

describe("plan()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns SubagentPlan array on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Analyze BTC market data for momentum and trend", priority: 1 },
        { factor: "onchain", instruction: "Check on-chain metrics for BTC", priority: 2 },
      ]) } }],
    })

    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical", "onchain"] },
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toContain("Analyze BTC")
    expect(result[0].priority).toBe(1)
    expect(result[1].factor).toBe("onchain")
  })

  it("returns empty array on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical"] },
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await plan({
      asset: "BTC",
      category: { name: "major", activeFactors: ["technical"] },
    })
    expect(result).toEqual([])
  })
})

describe("rePlan()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns SubagentPlan array for low-confidence factors", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Re-analyze with additional price data and trend indicators", priority: 1 },
      ]) } }],
    })

    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toHaveLength(1)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toContain("Re-analyze")
    expect(result[0].priority).toBe(1)
  })

  it("returns empty array on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await rePlan({
      asset: "BTC",
      category: "major",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })
})

describe("aggregate()", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns valid aggregation on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        thesis: "BTC is bullish overall across technical and on-chain factors",
        crossValidation: {
          pairs: [{ factorA: "technical", factorB: "onchain", alignment: 80, note: "Both indicate strength" }],
          overallAlignment: 80,
          contradictions: [],
        },
        risks: [{ factor: "technical", description: "RSI overbought", severity: "medium" }],
        catalysts: [{ factor: "onchain", description: "Exchange outflows rising", impact: "high" }],
        summary: "BTC looks strong across all analyzed factors with manageable risk.",
      }) } }],
    })

    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result).not.toBeNull()
    if (!result) return // type guard
    expect(result.thesis).toBe("BTC is bullish overall across technical and on-chain factors")
    expect(result.crossValidation.overallAlignment).toBe(80)
    expect(result.crossValidation.pairs).toHaveLength(1)
    expect(result.crossValidation.pairs[0].factorA).toBe("technical")
    expect(result.crossValidation.pairs[0].alignment).toBe(80)
    expect(result.risks).toHaveLength(1)
    expect(result.risks[0].severity).toBe("medium")
    expect(result.catalysts).toHaveLength(1)
    expect(result.catalysts[0].impact).toBe("high")
    expect(result.summary).toBeTruthy()
  })

  it("returns null on LLM error instead of fake data", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result).toBeNull()
  })

  it("returns null on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result).toBeNull()
  })

  it("retries with error feedback when aggregate JSON parse fails, then succeeds", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        thesis: "BTC is bullish",
        crossValidation: { pairs: [], overallAlignment: 70, contradictions: [] },
        risks: [],
        catalysts: [],
        summary: "Summary",
      }) } }],
    })

    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result).not.toBeNull()
    if (!result) return // type guard
    expect(result.thesis).toBe("BTC is bullish")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryMessages = mockCreate.mock.calls[1][0].messages
    const retryContent = retryMessages[retryMessages.length - 1].content
    expect(retryContent).toContain("Your previous response was not valid JSON")
    expect(retryContent).toContain("Invalid JSON:")
    expect(retryContent).toContain("rawPrefix: not valid json")
  })

  it("returns null when aggregate retry and repair both fail", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "still not valid json" } }],
    })
    const result = await aggregate({
      asset: "BTC",
      category: "major",
      factorReports: [],
    })
    expect(result).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})

describe("REACT_SYSTEM_PROMPT", () => {
  const tools = {
    get_price: {
      name: "get_price",
      description: "Get the current price for an asset",
      parameters: z.object({ asset: z.string() }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
    get_trend: {
      name: "get_trend",
      description: "Get the current market trend direction",
      parameters: z.object({}),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
  }

  it("includes tool names and descriptions for given tools", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("get_price")
    expect(prompt).toContain("get_trend")
    expect(prompt).toContain("Get the current price for an asset")
    expect(prompt).toContain("Get the current market trend direction")
  })

  it("does not include parameter schemas in tool descriptions", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).not.toContain("{asset}")
    expect(prompt).not.toContain("()")
    expect(prompt).toContain("- get_price: Get the current price for an asset")
  })

  it("demands JSON-only output with the schema in a markdown codeblock", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("Respond ONLY with valid JSON")
    expect(prompt).toContain("```json")
    for (const field of ["action", "score", "confidence", "signals", "reasoning", "conclusion"]) {
      expect(prompt).toContain(field)
    }
  })

  it("includes the instruction in the prompt", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("Analyze BTC market data")
  })

  it("includes the factor name in the prompt", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", tools, "Analyze BTC market data")
    expect(prompt).toContain("technical")
  })
})

describe("PROMPT constants exist", () => {
  it("PLAN_PROMPT is defined and non-empty", () => {
    expect(PLAN_PROMPT).toBeTruthy()
    expect(PLAN_PROMPT.length).toBeGreaterThan(50)
  })

  it("REPLAN_PROMPT is defined and non-empty", () => {
    expect(REPLAN_PROMPT).toBeTruthy()
    expect(REPLAN_PROMPT.length).toBeGreaterThan(50)
  })

  it("AGGREGATE_PROMPT is defined and non-empty", () => {
    expect(AGGREGATE_PROMPT).toBeTruthy()
    expect(AGGREGATE_PROMPT.length).toBeGreaterThan(50)
  })

  it("AGGREGATE_PROMPT instructs strict JSON output matching the schema", () => {
    expect(AGGREGATE_PROMPT).toContain("Respond ONLY with valid JSON")
    expect(AGGREGATE_PROMPT).toContain("Output MUST match this schema:")
    expect(AGGREGATE_PROMPT).toContain("```json")
    for (const field of ["thesis", "crossValidation", "risks", "catalysts", "summary"]) {
      expect(AGGREGATE_PROMPT).toContain(field)
    }
  })
})

describe("think() with native tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  const nativeTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "get_price",
        description: "Get price",
        parameters: { type: "object", properties: { asset: { type: "string" } } },
      },
    },
  ]

  it("includes tools in the create call when provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return", score: 50, confidence: 50, signals: [], reasoning: "ok", conclusion: "ok",
      }) } }],
    })

    await think([{ role: "user", content: "test" }], { tools: nativeTools })

    expect(mockCreate.mock.calls[0][0].tools).toBeDefined()
    expect(mockCreate.mock.calls[0][0].tools).toHaveLength(1)
    expect(mockCreate.mock.calls[0][0].tools[0].function.name).toBe("get_price")
  })

  it("omits tools from the create call when not provided", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "{}" } }],
    })

    await think([{ role: "user", content: "test" }])

    expect(mockCreate.mock.calls[0][0].tools).toBeUndefined()
  })

  it("returns native tool calls when the model responds with tool_calls", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_price", arguments: '{"asset":"BTC"}' } },
            { id: "call_2", type: "function", function: { name: "get_trend", arguments: "{}" } },
          ],
        },
      }],
    })

    const result = await think([{ role: "user", content: "test" }], { tools: nativeTools })

    expect(result.action).toBe("native_tool_call")
    if (result.action !== "native_tool_call") throw new Error("Expected native_tool_call")
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].id).toBe("call_1")
    expect(result.toolCalls[0].toolName).toBe("get_price")
    expect(result.toolCalls[0].rawArguments).toBe('{"asset":"BTC"}')
    expect(result.toolCalls[1].toolName).toBe("get_trend")
    expect(result.assistantMessage.role).toBe("assistant")
  })

  it("returns a parsed SubAgentThought when the model answers with content despite tools", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "return",
        score: 60,
        confidence: 55,
        signals: [],
        reasoning: "Analysis complete",
        conclusion: "Neutral",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }], { tools: nativeTools })

    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(60)
    }
  })

  it("honors a native tool_call retry response when the first content failed to parse", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call_retry", type: "function", function: { name: "get_price", arguments: "{}" } }],
        },
      }],
    })

    const result = await think([{ role: "user", content: "test" }], { tools: nativeTools })

    expect(result.action).toBe("native_tool_call")
    if (result.action !== "native_tool_call") throw new Error("Expected native_tool_call")
    expect(result.toolCalls[0].id).toBe("call_retry")
  })
})

describe("DeepSeek json_schema mode integration", () => {
  // reason: unit-test beforeEach blocks above overwrite DEEPSEEK_API_KEY with a
  // fake key — capture the pristine value at collection time, before tests run.
  const realApiKey = process.env.DEEPSEEK_API_KEY

  // reason: feasibility probe for switching think()/aggregate() from json_object
  // to json_schema response_format. Requires a real API key; silently passes
  // (skips) in CI or local runs without one. If DeepSeek rejects json_schema,
  // this test FAILS when run with a key — that is the signal to keep json_object.
  it("json_schema response_format works against real DeepSeek (skipped without DEEPSEEK_API_KEY)", async () => {
    if (!realApiKey || process.env.CI) {
      console.warn("Skipping json_schema integration test: no DEEPSEEK_API_KEY or CI is set")
      return
    }
    const apiKey = realApiKey

    const { default: RealOpenAI } = await vi.importActual<typeof import("openai")>("openai")
    const client = new RealOpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    })

    const response = await client.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      temperature: 0.3,
      max_tokens: 1024,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "dd_thought",
          strict: true,
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["tool_call", "return"] },
              score: { type: "number" },
              confidence: { type: "number" },
              signals: { type: "array" },
            },
            required: ["action", "score", "confidence", "signals"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: "Return a JSON thought for the dd_thought schema." }],
    })

    const content = response.choices?.[0]?.message?.content || ""
    expect(() => JSON.parse(content)).not.toThrow()
  })
})
