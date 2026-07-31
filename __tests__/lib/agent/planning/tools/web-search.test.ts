/**
 * @file web-search.test.ts
 * @description Tests for the Exa web-search tool. Mocks global fetch; verifies
 * the fast-fail path when EXA_API_KEY is not configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

import { buildWebSearchTools } from "@/lib/agent/planning/tools/web-search"

const CTX = { walletAddress: "0xabc", userId: "user_1", asset: "ETH", equity: 10000 }

const tools = () => Object.fromEntries(buildWebSearchTools(CTX).map((t) => [t.name, t]))

const jsonResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("EXA_API_KEY", "test-key-123")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("web_search", () => {
  it("returns results mapped to { title, url, text }", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { title: "BTC rallies", url: "https://example.com/1", text: "Bitcoin is up today", id: "x" },
          { title: "Fed decision", url: "https://example.com/2", text: "Fed holds rates", id: "y" },
        ],
      })
    )
    const result = await tools().web_search.execute({ query: "BTC news today" })
    expect(result.success).toBe(true)
    expect(result.data.results).toEqual([
      { title: "BTC rallies", url: "https://example.com/1", text: "Bitcoin is up today" },
      { title: "Fed decision", url: "https://example.com/2", text: "Fed holds rates" },
    ])
    expect(result.metadata.source).toBe("exa")
  })

  it("posts to the Exa search endpoint with bearer auth and numResults 5", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }))
    await tools().web_search.execute({ query: "ETH ETF" })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://api.exa.ai/search")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer test-key-123")
    expect(JSON.parse(init.body)).toEqual({ query: "ETH ETF", numResults: 5 })
  })

  it("coerces missing result text to empty string", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [{ title: "No text", url: "https://example.com/3" }] })
    )
    const result = await tools().web_search.execute({ query: "query" })
    expect(result.success).toBe(true)
    expect(result.data.results).toEqual([{ title: "No text", url: "https://example.com/3", text: "" }])
  })

  it("returns success:false fast when EXA_API_KEY is missing, without a network call", async () => {
    vi.stubEnv("EXA_API_KEY", "")
    const result = await tools().web_search.execute({ query: "BTC" })
    expect(result.success).toBe(false)
    expect(result.error).toBe("EXA_API_KEY not configured")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns success:false when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"))
    const result = await tools().web_search.execute({ query: "BTC" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("network down")
  })

  it("returns success:false on non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
    const result = await tools().web_search.execute({ query: "BTC" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("429")
  })

  it("validates query parameter", () => {
    expect(() => tools().web_search.parameters.parse({})).toThrow()
    expect(() => tools().web_search.parameters.parse({ query: 123 })).toThrow()
  })
})
