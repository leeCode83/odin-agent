import { describe, it, expect } from "vitest"
import { parseLlmJson, repairJSON, parseInvokeXml } from "@/lib/agent/due-diligence/json"

describe("parseLlmJson", () => {
  it("parses plain valid JSON", () => {
    expect(parseLlmJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it("parses JSON followed by trailing prose (reasoning-model drift)", () => {
    const content = '{"action":"return","score":65,"confidence":70}\n\nThis analysis considers momentum and volatility.\nOverall I remain bullish.'
    expect(parseLlmJson(content)).toEqual({ action: "return", score: 65, confidence: 70 })
  })

  it("strips markdown code fences", () => {
    const content = '```json\n{"action":"return","score":50}\n```'
    expect(parseLlmJson(content)).toEqual({ action: "return", score: 50 })
  })

  it("extracts first balanced object when prose precedes the JSON", () => {
    const content = 'Here is my analysis:\n{"action":"tool_call","toolName":"get_rsi","params":{"timeframe":"1h"}}\nDone.'
    expect(parseLlmJson(content)).toEqual({ action: "tool_call", toolName: "get_rsi", params: { timeframe: "1h" } })
  })

  it("ignores a truncated leading object when a later balanced object exists", () => {
    const content = '{"action":"return","score":4' // truncated start
    expect(parseLlmJson(content)).not.toBeNull()
  })

  it("repairs truncated JSON (unclosed braces and strings)", () => {
    const content = '{"action":"return","score":70,"confidence":80,"signals":[{"name":"RSI","strength":70'
    const parsed = parseLlmJson(content)
    expect(parsed).not.toBeNull()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      expect((parsed as Record<string, unknown>).action).toBe("return")
    }
  })

  it("returns null for irreparable garbage", () => {
    expect(parseLlmJson("not json at all")).toBeNull()
    expect(parseLlmJson("")).toBeNull()
  })
})

describe("repairJSON", () => {
  it("returns parsed object when already valid", () => {
    expect(repairJSON('{"a": 1}')).toEqual({ a: 1 })
  })

  it("closes unclosed braces", () => {
    expect(repairJSON('{"a": {"b": 1}')).toEqual({ a: { b: 1 } })
  })

  it("returns null when beyond repair", () => {
    expect(repairJSON("garbage")).toBeNull()
  })
})

describe("parseInvokeXml", () => {
  it("parses a single invoke block with no params", () => {
    expect(parseInvokeXml('<invoke name="get_fear_greed">\n</invoke>')).toEqual([
      { toolName: "get_fear_greed", params: {} },
    ])
  })

  it("parses multiple blocks with typed params", () => {
    const content =
      '<invoke name="get_asset_momentum">\n<parameter name="coinId" string="false">1027</parameter>\n</invoke>\n' +
      '<invoke name="get_trending_coins">\n</invoke>'
    expect(parseInvokeXml(content)).toEqual([
      { toolName: "get_asset_momentum", params: { coinId: 1027 } },
      { toolName: "get_trending_coins", params: {} },
    ])
  })

  it("keeps string params as strings", () => {
    expect(parseInvokeXml('<invoke name="get_rsi"><parameter name="timeframe">1h</parameter></invoke>')).toEqual([
      { toolName: "get_rsi", params: { timeframe: "1h" } },
    ])
  })

  it("extracts invoke blocks embedded in JSON-ish hybrid output", () => {
    // reason: the observed drift — output starts like JSON, then switches to XML
    const content = '{\n\n<invoke name="get_fear_greed">\n\n</invoke>\n<invoke name="get_asset_momentum">\n<parameter name="coinId" string="false">1027</parameter>\n</invoke>'
    const calls = parseInvokeXml(content)
    expect(calls).not.toBeNull()
    expect(calls).toHaveLength(2)
    expect(calls?.[1].params).toEqual({ coinId: 1027 })
  })

  it("decodes XML entities in values", () => {
    expect(
      parseInvokeXml('<invoke name="get_coin_sentiment"><parameter name="query">ETH &amp; BTC &quot;long&quot;</parameter></invoke>')
    ).toEqual([{ toolName: "get_coin_sentiment", params: { query: 'ETH & BTC "long"' } }])
  })

  it("returns null when no invoke block exists", () => {
    expect(parseInvokeXml('{"action":"return","score":70}')).toBeNull()
    expect(parseInvokeXml("")).toBeNull()
  })

  it("returns null for malformed blocks", () => {
    expect(parseInvokeXml('<invoke name="get_rsi">')).toBeNull()
  })
})
