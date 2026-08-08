/**
 * @file llm-rethought.test.ts
 * @description Unit + integration tests for the due-diligence LLM layer: think/plan/rePlan/aggregate
 *   with mocked OpenAI client, plus a real-API DeepSeek json_schema feasibility test (key-gated).
 * @module due-diligence
 * @layer service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { think, plan, rePlan, aggregate, normalizeThought, formatZodErrors } from "@/lib/agent/due-diligence/llm"
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
      expect(result.score).toBeNull()
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

  it("converts Claude-style XML invoke blocks into native tool calls (no retry)", async () => {
    // reason: the observed drift — DeepSeek reasoning models reply with
    // <invoke name="..."> XML instead of JSON; the parser must embrace it.
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content:
            '{\n\n<invoke name="get_fear_greed">\n\n</invoke>\n' +
            '<invoke name="get_asset_momentum">\n<parameter name="coinId" string="false">1027</parameter>\n</invoke>',
        },
      }],
    })
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("native_tool_call")
    if (result.action === "native_tool_call") {
      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].toolName).toBe("get_fear_greed")
      expect(result.toolCalls[1].toolName).toBe("get_asset_momentum")
      expect(JSON.parse(result.toolCalls[1].rawArguments)).toEqual({ coinId: 1027 })
    }
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("converts XML invoke blocks in the retry response too", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '<invoke name="get_rsi"><parameter name="timeframe">1h</parameter></invoke>' } }],
    })
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("native_tool_call")
    if (result.action === "native_tool_call") {
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].toolName).toBe("get_rsi")
      expect(JSON.parse(result.toolCalls[0].rawArguments)).toEqual({ timeframe: "1h" })
    }
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
    expect(retryContent).toContain("rawPrefix: not valid json")
  })

  it("retries with Zod error feedback when schema validation fails", async () => {
    // First attempt: missing required fields for tool_call
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "tool_call",
        // Missing toolName and params
      }) } }],
    })
    // Second attempt: corrected JSON
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        action: "tool_call",
        toolName: "get_price",
        params: { asset: "BTC" },
        reasoning: "Need price",
      }) } }],
    })

    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("tool_call")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryMessages = mockCreate.mock.calls[1][0].messages
    const retryContent = retryMessages[retryMessages.length - 1].content
    expect(retryContent).toContain("validation error")
    expect(retryContent).toContain("Please return corrected JSON only.")
  })

  it("returns fallback after max schema correction retries exhausted", async () => {
    // All attempts: invalid schema
    for (let i = 0; i < 3; i++) {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({
          action: "tool_call"
          // Missing toolName, etc.
        }) } }],
      })
    }
    
    const result = await think([{ role: "user", content: "test" }])
    expect(result.action).toBe("return")
    // Fallback has null score (fake 0 would pollute scoring downstream)
    if (result.action === "return") {
      expect(result.score).toBeNull()
    }
    expect(mockCreate).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
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

describe("think() empty-response retry", () => {
  // reason: retries sleep on real timers — fake timers keep the tests fast and
  // deterministic; scoped to this block so existing real-timer tests are untouched.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("retries empty content then succeeds", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
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

    // reason: the think() promise hangs on the backoff timers (1s then 2s) until
    // fake time is advanced — flush 5s to cover both sleeps, then read the result.
    const promise = think([{ role: "user", content: "test" }])
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBe(75)
    }
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("returns fallback after 3 empty responses", async () => {
    for (let i = 0; i < 3; i++) {
      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
    }

    const promise = think([{ role: "user", content: "test" }])
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.action).toBe("return")
    // Fallback has null score (fake 0 would pollute scoring downstream)
    if (result.action === "return") {
      expect(result.score).toBeNull()
    }
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it("missing message falls back after 3 attempts", async () => {
    mockCreate.mockResolvedValue({ choices: [] })

    const promise = think([{ role: "user", content: "test" }])
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.action).toBe("return")
    if (result.action === "return") {
      expect(result.score).toBeNull()
    }
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })
})

describe("normalizeThought()", () => {
  it("normalizes tool_call with missing reasoning to empty string", () => {
    const raw = {
      action: "tool_call",
      toolName: "get_price",
      params: { asset: "BTC" }
    }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.action).toBe("tool_call")
    expect(result.reasoning).toBe("")
  })

  it("does not overwrite existing reasoning in tool_call", () => {
    const raw = {
      action: "tool_call",
      toolName: "get_price",
      params: { asset: "BTC" },
      reasoning: "I need to check the price."
    }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.reasoning).toBe("I need to check the price.")
  })

  it("normalizes missing action to return", () => {
    const raw = { score: 50 }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.action).toBe("return")
    expect(result.reasoning).toBe("No reasoning provided — LLM returned incomplete response")
  })
})

describe("formatZodErrors()", () => {
  it("returns empty string for empty issues array", () => {
    expect(formatZodErrors([])).toBe("")
  })

  it("formats standard field requirement error", () => {
    const issues: z.ZodIssue[] = [
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        path: ["reasoning"],
        message: "Required",
      } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('Your previous response had 1 validation error')
    expect(result).toContain('1. Field "reasoning"')
    expect(result).toContain('Required')
  })

  it("formats nested array field error nicely", () => {
    const issues: z.ZodIssue[] = [
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "number",
        received: "string",
        path: ["signals", 0, "strength"],
        message: "Expected number, received string",
      } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('1. Field "signals[0].strength"')
    expect(result).toContain('Expected number, received string')
  })

  it("handles multiple errors", () => {
    const issues: z.ZodIssue[] = [
      { code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["toolName"], message: "Required" } as z.ZodIssue,
      { code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["reasoning"], message: "Required" } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('Your previous response had 2 validation errors:')
    expect(result).toContain('1. Field "toolName"')
    expect(result).toContain('2. Field "reasoning"')
    expect(result).toContain('Please return corrected JSON only.')
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
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await plan({
      asset: "BTC",
    })
    expect(result).toEqual([])
  })

  it("filters out items with invalid factor", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Valid instruction", priority: 1 },
        { factor: "invalid_factor", instruction: "Invalid instruction", priority: 2 },
      ]) } }],
    })

    const result = await plan({
      asset: "BTC",
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result.map((p) => p.factor)).not.toContain("invalid_factor")
    expect(result.some((p) => p.factor === "onchain")).toBe(true)
  })

  it("filters out items with empty instruction and enforces mandatory factors", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Valid instruction", priority: 1 },
        { factor: "onchain", instruction: "", priority: 2 },
      ]) } }],
    })

    const result = await plan({
      asset: "BTC",
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    const onchain = result.find((p) => p.factor === "onchain")
    expect(onchain?.instruction.length).toBeGreaterThan(0)
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
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result[0].instruction).toContain("Re-analyze")
    expect(result[0].priority).toBe(1)
    expect(result.some((p) => p.factor === "onchain")).toBe(true)
  })

  it("returns empty array on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await rePlan({
      asset: "BTC",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })

  it("returns empty array on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await rePlan({
      asset: "BTC",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toEqual([])
  })

  it("filters out items with invalid factor", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Valid instruction", priority: 1 },
        { factor: "invalid_factor", instruction: "Invalid instruction", priority: 2 },
      ]) } }],
    })

    const result = await rePlan({
      asset: "BTC",
      lowConfidenceFactors: ["technical"],
      previousReports: [],
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    expect(result.map((p) => p.factor)).not.toContain("invalid_factor")
  })

  it("filters out items with empty instruction and enforces mandatory factors", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify([
        { factor: "technical", instruction: "Valid instruction", priority: 1 },
        { factor: "onchain", instruction: "", priority: 2 },
      ]) } }],
    })

    const result = await rePlan({
      asset: "BTC",
      lowConfidenceFactors: ["technical", "onchain"],
      previousReports: [],
    })
    expect(result).toHaveLength(2)
    expect(result[0].factor).toBe("technical")
    const onchain = result.find((p) => p.factor === "onchain")
    expect(onchain?.instruction.length).toBeGreaterThan(0)
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
      factorReports: [],
    })
    expect(result).toBeNull()
  })

  it("returns null on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await aggregate({
      asset: "BTC",
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
      factorReports: [],
    })
    expect(result).not.toBeNull()
    if (!result) return // type guard
    expect(result.thesis).toBe("BTC is bullish")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryMessages = mockCreate.mock.calls[1][0].messages
    const retryContent = retryMessages[retryMessages.length - 1].content
    expect(retryContent).toContain("Your previous response was not valid JSON")
    expect(retryContent).toContain("rawPrefix: not valid json")
  })

  it("returns null when aggregate retry and repair both fail", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "still not valid json" } }],
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "still not valid json 3" } }],
    })
    const result = await aggregate({
      asset: "BTC",
      factorReports: [],
    })
    expect(result).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it("retries with Zod error feedback when schema validation fails", async () => {
    // Attempt 1: returns object missing required fields
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ thesis: "missing stuff" }) } }],
    })
    // Attempt 2: returns valid AggregationResult
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              thesis: "BTC is bullish",
              crossValidation: { pairs: [], overallAlignment: 50, contradictions: [] },
              risks: [],
              catalysts: [],
              summary: "A summary",
            }),
          },
        },
      ],
    })

    const result = await aggregate({
      asset: "BTC",
      factorReports: [],
    })
    expect(result?.thesis).toBe("BTC is bullish")
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const retryMessages = mockCreate.mock.calls[1][0].messages
    const retryContent = retryMessages[retryMessages.length - 1].content
    expect(retryContent).toContain("Your previous response was invalid against the required schema")
    expect(retryContent).toContain("crossValidation")
  })

  it("returns null after max aggregate schema correction retries exhausted", async () => {
    // Attempt 1, 2, 3: returns missing fields
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ thesis: "missing stuff" }) } }],
    })

    const result = await aggregate({
      asset: "BTC",
      factorReports: [],
    })
    expect(result).toBeNull()
    expect(mockCreate).toHaveBeenCalledTimes(3)
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
