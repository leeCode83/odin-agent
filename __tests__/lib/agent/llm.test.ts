import { describe, it, expect, vi, beforeEach } from "vitest"
import { analyzeSection, synthesizeSections } from "@/lib/agent/llm"

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

describe("analyzeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  it("returns a valid SectionResult on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ score: 72, summary: "Bullish", signals: ["RSI oversold"] }) } }],
    })

    const result = await analyzeSection("technical", { someData: "test" })
    expect(result).toHaveProperty("score")
    expect(result).toHaveProperty("summary")
    expect(result).toHaveProperty("signals")
    expect(result.score).toBe(72)
  })

  it("returns null section on missing API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await analyzeSection("technical", { someData: "test" })
    expect(result.score).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns null section on LLM error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"))
    const result = await analyzeSection("technical", { someData: "test" })
    expect(result.score).toBeNull()
  })

  it("retries once on JSON parse failure", async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: "bad json" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ score: 50, summary: "retry", signals: [] }) } }] })

    const result = await analyzeSection("technical", { someData: "test" })
    expect(result.score).toBe(50)
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})

describe("synthesizeSections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DEEPSEEK_API_KEY = "test-key"
  })

  const mockSections = {
    technical: { score: 72, summary: "bullish", signals: ["RSI"] },
    onchain: { score: 65, summary: "neutral", signals: ["OI up"] },
    sentiment: { score: null, summary: null, signals: [] },
    fundamental: { score: null, summary: null, signals: [] },
  }

  it("returns synthesis result on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        aggregated_thesis: "BTC looks good",
        confidence_score: 78,
        risk_flags: [],
        errors: [],
      }) } }],
    })

    const result = await synthesizeSections("BTC", "major", mockSections)
    expect(result).toHaveProperty("thesis")
    expect(result).toHaveProperty("confidence")
    expect(result).toHaveProperty("flags")
    expect(result.thesis).toBe("BTC looks good")
    expect(result.confidence).toBe(78)
  })

  it("returns default on error (no crash)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API down"))
    const result = await synthesizeSections("BTC", "major", mockSections)
    expect(result.thesis).toBeTruthy()
    expect(result.confidence).toBe(0)
    expect(result.flags).toContain("LLM aggregation failed")
  })
})
