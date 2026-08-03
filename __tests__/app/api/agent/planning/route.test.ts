/**
 * @file __tests__/app/api/agent/planning/route.test.ts
 * @description Route tests for POST /api/agent/planning: request validation
 *   (400), circuit breaker rejection (503, spec §9.7), success envelope, and
 *   spec §9.6 error shapes (PLANNING_FAILED / CONSENSUS_FAILED).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { PlanningError } from "@/lib/agent/planning/pipeline"

const {
  mockRunPlanningPipeline,
  mockIsDDPanicked,
  mockIsLLMPanicked,
  mockRecordDDFailure,
  mockRecordLLMFailure,
} = vi.hoisted(() => ({
  mockRunPlanningPipeline: vi.fn(),
  mockIsDDPanicked: vi.fn(),
  mockIsLLMPanicked: vi.fn(),
  mockRecordDDFailure: vi.fn(),
  mockRecordLLMFailure: vi.fn(),
}))

vi.mock("@/lib/agent/pipeline", () => ({
  runPlanningPipeline: mockRunPlanningPipeline,
}))

vi.mock("@/lib/agent/planning/circuit-breaker", () => ({
  planningCircuitBreaker: {
    isDDPanicked: mockIsDDPanicked,
    isLLMPanicked: mockIsLLMPanicked,
    recordDDFailure: mockRecordDDFailure,
    recordLLMFailure: mockRecordLLMFailure,
  },
}))

const VALID_PLAN = {
  asset: "BTC",
  side: "long",
  action: "LONG",
  entry_price: 65000,
  position_size_usdc: 50,
  position_size_contracts: 0.001,
  stop_loss: 64000,
  take_profit: 68000,
  leverage: 3,
  confidence_score: 72,
  confidence_breakdown: {
    factor_alignment: 75,
    historical_match: 60,
    signal_strength: 80,
  },
  thesis: "BTC bullish",
  reasoning: "Consensus",
  autonomy_decision: "auto",
  risk_flags: [],
  graph_patterns_used: [],
  timestamp: "2025-01-01T00:00:00Z",
  iterations: 3,
}

const NO_TRADE_PLAN = { ...VALID_PLAN, action: "NO_TRADE" }

const VALID_TIMING = { totalMs: 100, agentMs: 80 }

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/planning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function createInvalidRequest(body: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/planning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/agent/planning/route")
  return POST(createRequest(body))
}

describe("POST /api/agent/planning", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsDDPanicked.mockReturnValue(false)
    mockIsLLMPanicked.mockReturnValue(false)
    mockRunPlanningPipeline.mockResolvedValue({ report: VALID_PLAN, timing: VALID_TIMING })
  })

  it("returns 200 with report, timing, iterations, and status for valid input", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.report.asset).toBe("BTC")
    expect(data.report.action).toBe("LONG")
    expect(data.timing.totalMs).toBe(100)
    expect(data.iterations).toBe(3)
    expect(data.status).toBe("complete")
    expect(mockRunPlanningPipeline).toHaveBeenCalledWith({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0x123",
      targetProfitPercent: undefined,
    })
  })

  it("returns 200 for NO_TRADE with status no_trade", async () => {
    mockRunPlanningPipeline.mockResolvedValue({ report: NO_TRADE_PLAN, timing: VALID_TIMING })

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.report.action).toBe("NO_TRADE")
    expect(data.status).toBe("no_trade")
  })

  it("passes a decimal targetProfitPercent to the pipeline", async () => {
    await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", targetProfitPercent: 20.5 })

    expect(mockRunPlanningPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ targetProfitPercent: 20.5 })
    )
  })

  it("returns 400 when asset is missing", async () => {
    const res = await post({ userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("asset, userId, and walletAddress required")
  })

  it("returns 400 when userId is missing", async () => {
    const res = await post({ asset: "BTC", walletAddress: "0x123" })

    expect(res.status).toBe(400)
  })

  it("returns 400 when walletAddress is missing", async () => {
    const res = await post({ asset: "BTC", userId: "user-1" })

    expect(res.status).toBe(400)
  })

  it("returns 400 when asset is empty", async () => {
    const res = await post({ asset: "", userId: "user-1", walletAddress: "0x123" })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("asset, userId, and walletAddress required")
  })

  it("returns 400 when targetProfitPercent is zero", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", targetProfitPercent: 0 })
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("Invalid targetProfitPercent")
    expect(data.detail).toBeDefined()
  })

  it("returns 400 when targetProfitPercent is negative", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", targetProfitPercent: -5 })

    expect(res.status).toBe(400)
  })

  it("returns 400 when targetProfitPercent exceeds 1000", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", targetProfitPercent: 1001 })

    expect(res.status).toBe(400)
  })

  it("returns 400 when targetProfitPercent is a fraction string", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", targetProfitPercent: "1/2" })

    expect(res.status).toBe(400)
  })

  it("returns 400 for malformed JSON body", async () => {
    const { POST } = await import("@/app/api/agent/planning/route")
    const res = await POST(createInvalidRequest("not-json"))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("Invalid JSON body")
  })

  it("returns 503 with retryAfterSeconds 60 when the DD breaker is panicked", async () => {
    mockIsDDPanicked.mockReturnValue(true)

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(503)
    expect(data.error).toBe("PLANNING_UNAVAILABLE")
    expect(data.retryAfterSeconds).toBe(60)
    expect(mockRunPlanningPipeline).not.toHaveBeenCalled()
  })

  it("returns 503 with retryAfterSeconds 120 when the LLM breaker is panicked", async () => {
    mockIsLLMPanicked.mockReturnValue(true)

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(503)
    expect(data.error).toBe("PLANNING_UNAVAILABLE")
    expect(data.retryAfterSeconds).toBe(120)
    expect(mockRunPlanningPipeline).not.toHaveBeenCalled()
  })

  it("returns 200 with status approval_required when the pipeline reports it", async () => {
    mockRunPlanningPipeline.mockResolvedValue({
      report: VALID_PLAN,
      timing: VALID_TIMING,
      status: "approval_required",
    })

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.status).toBe("approval_required")
  })

  it("returns 422 PLANNING_FAILED for a dd-category error and records a DD failure", async () => {
    mockRunPlanningPipeline.mockRejectedValue(
      new PlanningError(
        "Planning pipeline failed for BTC: PLANNING_FAILED",
        { phase: "dd", reports: [], aggregation: null, ddReport: null, message: "DD agent down" },
        321,
        "dd"
      )
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(422)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.message).toContain("Planning pipeline failed for BTC")
    expect(data.details.phase).toBe("dd")
    expect(data.details.ddReport).toBeNull()
    expect(data.processingTimeMs).toBe(321)
    expect(mockRecordDDFailure).toHaveBeenCalledTimes(1)
    expect(mockRecordLLMFailure).not.toHaveBeenCalled()
  })

  it("returns 422 PLANNING_FAILED for an llm-category error and records an LLM failure", async () => {
    mockRunPlanningPipeline.mockRejectedValue(
      new PlanningError(
        "Planning pipeline failed for BTC: LLM JSON parse failed",
        { phase: "aggregate" },
        100,
        "llm"
      )
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(422)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.details.phase).toBe("aggregate")
    expect(mockRecordDDFailure).not.toHaveBeenCalled()
    expect(mockRecordLLMFailure).toHaveBeenCalledTimes(1)
  })

  it("returns 502 PLANNING_FAILED for a data-category error and records an LLM failure", async () => {
    mockRunPlanningPipeline.mockRejectedValue(
      new PlanningError(
        "Planning pipeline failed for BTC: market data provider unreachable",
        { phase: "execute" },
        200,
        "data"
      )
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(502)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.details.phase).toBe("execute")
    expect(mockRecordLLMFailure).toHaveBeenCalledTimes(1)
  })

  it("returns 500 CONSENSUS_FAILED for phase evaluate with detail spread through", async () => {
    mockRunPlanningPipeline.mockRejectedValue(
      new PlanningError(
        "Planning pipeline failed for BTC: PLANNING_FAILED",
        { phase: "evaluate", reports: [{ perspective: "conservative" }], aggregation: { confidence_score: 40 }, ddReport: { asset: "BTC" } },
        555
      )
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe("CONSENSUS_FAILED")
    expect(data.details.phase).toBe("evaluate")
    expect(data.details.reports).toHaveLength(1)
    expect(data.details.aggregation).toEqual({ confidence_score: 40 })
    expect(data.processingTimeMs).toBe(555)
    expect(mockRecordDDFailure).not.toHaveBeenCalled()
    expect(mockRecordLLMFailure).not.toHaveBeenCalled()
  })

  it("returns 500 PLANNING_FAILED for a generic PlanningError and records an LLM failure", async () => {
    mockRunPlanningPipeline.mockRejectedValue(
      new PlanningError("Planning pipeline failed for BTC: upstream LLM rejected")
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.details).toEqual({})
    expect(mockRecordLLMFailure).toHaveBeenCalledTimes(1)
  })

  it("returns 500 PLANNING_FAILED for a raw non-PlanningError and records an LLM failure", async () => {
    mockRunPlanningPipeline.mockRejectedValue(new Error("LLM connection reset"))

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.message).toContain("LLM connection reset")
    expect(mockRecordLLMFailure).toHaveBeenCalledTimes(1)
  })
})
