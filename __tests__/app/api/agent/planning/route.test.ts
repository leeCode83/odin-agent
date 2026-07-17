import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/planning/route"

const { mockRunPlanningPipeline } = vi.hoisted(() => ({
  mockRunPlanningPipeline: vi.fn(),
}))

vi.mock("@/lib/agent/pipeline", () => ({
  runPlanningPipeline: mockRunPlanningPipeline,
}))

const validDDReport = {
  asset: "BTC",
  category: "major",
  timestamp: "2025-01-01T00:00:00Z",
  sections: {
    technical: { score: 70, summary: "Bullish", signals: ["RSI > 60"] },
    onchain: { score: 60, summary: "Neutral", signals: [] },
    sentiment: { score: 55, summary: "Neutral", signals: [] },
    fundamental: { score: 80, summary: "Strong", signals: [] },
  },
  aggregated_thesis: "BTC has upside",
  confidence_score: 65,
  risk_flags: [],
  errors: [],
}

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/planning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/agent/planning", () => {
  it("returns 200 with TradePlan for valid input", async () => {
    mockRunPlanningPipeline.mockResolvedValue({
      plan: {
        asset: "BTC",
        side: "long",
        entry_price: 65000,
        position_size_usdc: 50,
        position_size_contracts: 0.001,
        stop_loss: 64000,
        take_profit: 68000,
        leverage: 3,
        confidence_score: 72,
        confidence_breakdown: { factor_alignment: 75, historical_match: 60, signal_strength: 80 },
        thesis: "BTC bullish",
        reasoning: "Consensus",
        autonomy_decision: "auto",
        risk_flags: [],
        graph_patterns_used: [],
        timestamp: "2025-01-01T00:00:00Z",
      },
      timing: { fetchMs: 50, graphMs: 50, llmMs: 40, riskEngineMs: 10, totalMs: 100 },
    })

    const res = await POST(createRequest({
      ddReport: validDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.plan.asset).toBe("BTC")
    expect(data.timing.totalMs).toBe(100)
  })

  it("returns 400 when ddReport is missing", async () => {
    const res = await POST(createRequest({
      userId: "user-1",
      walletAddress: "0x123",
    }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("ddReport, userId, and walletAddress required")
  })

  it("returns 400 when userId is missing", async () => {
    const res = await POST(createRequest({
      ddReport: validDDReport,
      walletAddress: "0x123",
    }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain("required")
  })

  it("returns 400 when walletAddress is missing", async () => {
    const res = await POST(createRequest({
      ddReport: validDDReport,
      userId: "user-1",
    }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain("required")
  })

  it("returns 400 when ddReport fails Zod validation", async () => {
    const res = await POST(createRequest({
      ddReport: { asset: "BTC" },
      userId: "user-1",
      walletAddress: "0x123",
    }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("Invalid ddReport")
    expect(data.detail).toBeDefined()
  })

  it("returns 400 for malformed JSON body", async () => {
    const req = new NextRequest(new Request("http://localhost:3000/api/agent/planning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }))
    const res = await POST(req)
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("Invalid JSON body")
  })

  it("returns 500 when pipeline throws", async () => {
    mockRunPlanningPipeline.mockRejectedValue(new Error("API unavailable"))

    const res = await POST(createRequest({
      ddReport: validDDReport,
      userId: "user-1",
      walletAddress: "0x123",
    }))
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe("Planning pipeline failed")
  })
})
