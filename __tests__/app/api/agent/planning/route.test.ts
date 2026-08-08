/**
 * @file __tests__/app/api/agent/planning/route.test.ts
 * @description Route tests for POST /api/agent/planning: request validation
 *   (400), circuit breaker rejection (503, spec §9.7), success envelope,
 *   spec §9.6 error shapes (PLANNING_FAILED / CONSENSUS_FAILED), F2 fresh-DD
 *   cache reuse (readRecentDDReport hit/miss/throw), and ddCoverage passthrough.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import { HyperliquidUniverseError } from "@/lib/agent/shared/hl-universe"

const {
  mockRunPlanningPipeline,
  mockIsDDPanicked,
  mockIsLLMPanicked,
  mockRecordDDFailure,
  mockRecordLLMFailure,
  mockRunDDAgent,
  mockReadRecentDDReport,
  mockAssertAssetInUniverse,
} = vi.hoisted(() => ({
  mockRunPlanningPipeline: vi.fn(),
  mockIsDDPanicked: vi.fn(),
  mockIsLLMPanicked: vi.fn(),
  mockRecordDDFailure: vi.fn(),
  mockRecordLLMFailure: vi.fn(),
  mockRunDDAgent: vi.fn(),
  mockReadRecentDDReport: vi.fn(),
  mockAssertAssetInUniverse: vi.fn(),
}))

vi.mock("@/lib/agent/shared/hl-universe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/shared/hl-universe")>()
  return { ...actual, assertAssetInUniverse: mockAssertAssetInUniverse }
})

vi.mock("@/lib/agent/pipeline", () => ({
  runPlanningPipeline: mockRunPlanningPipeline,
}))

vi.mock("@/lib/agent/due-diligence/agent", () => ({
  runDDAgent: mockRunDDAgent,
}))

vi.mock("@/lib/db/graph-memory", () => ({
  readRecentDDReport: mockReadRecentDDReport,
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
    mockRunDDAgent.mockResolvedValue({ asset: "BTC", status: "complete", sections: {} })
    mockReadRecentDDReport.mockResolvedValue(null)
    mockAssertAssetInUniverse.mockResolvedValue(undefined)
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
      ddReport: { asset: "BTC", status: "complete", sections: {} },
    })
  })

  it("uses a fresh cached DD report instead of running the DD agent", async () => {
    const cachedDD = {
      asset: "BTC",
      category: "major",
      timestamp: "2026-08-06T10:00:00.000Z",
      sections: {
        fundamental: { score: 80, signals: [], summary: "Strong" },
        onchain: { score: 60, signals: [], summary: "Neutral" },
        sentiment: { score: 55, signals: [], summary: "Neutral" },
        technical: { score: 70, signals: ["RSI > 60"], summary: "Bullish" },
      },
      aggregated_thesis: "BTC has upside",
      confidence_score: 65,
      risk_flags: [],
      errors: [],
      status: "complete",
      processingTimeMs: 250,
    }
    mockReadRecentDDReport.mockResolvedValue(cachedDD)

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(mockReadRecentDDReport).toHaveBeenCalledWith("BTC", "user-1")
    expect(mockRunDDAgent).not.toHaveBeenCalled()
    expect(mockRunPlanningPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ ddReport: cachedDD })
    )
    expect(data.report.asset).toBe("BTC")
  })

  it("falls back to the DD agent when no fresh cached report exists", async () => {
    mockReadRecentDDReport.mockResolvedValue(null)

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })

    expect(res.status).toBe(200)
    expect(mockReadRecentDDReport).toHaveBeenCalledWith("BTC", "user-1")
    expect(mockRunDDAgent).toHaveBeenCalledTimes(1)
  })

  it("falls back to the DD agent when the cache read throws", async () => {
    mockReadRecentDDReport.mockRejectedValue(new Error("db down"))

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })

    expect(res.status).toBe(200)
    expect(mockRunDDAgent).toHaveBeenCalledTimes(1)
  })

  it("passes ddCoverage through to the response when the pipeline reports it", async () => {
    const ddCoverage = { usableFactorCount: 3, totalFactors: 4, failedFactors: ["sentiment"] }
    mockRunPlanningPipeline.mockResolvedValue({
      report: VALID_PLAN,
      timing: VALID_TIMING,
      ddCoverage,
    })

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.ddCoverage).toEqual(ddCoverage)
  })

  it("omits ddCoverage from the response when the pipeline does not report it", async () => {
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).not.toHaveProperty("ddCoverage")
  })

  it("passes a provided ddReport to the pipeline without calling runDDAgent", async () => {
    const customDD = {
      aggregated_thesis: "BTC has upside",
      asset: "BTC",
      category: "major",
      timestamp: "2026-07-20T10:00:00Z",
      status: "complete",
      sections: {
        fundamental: { score: 80, signals: [], summary: "Strong" },
        onchain: { score: 60, signals: [], summary: "Neutral" },
        sentiment: { score: 55, signals: [], summary: "Neutral" },
        technical: { score: 70, signals: ["RSI > 60"], summary: "Bullish" },
      },
      confidence_score: 65,
      risk_flags: [],
      errors: [],
    }
    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123", ddReport: customDD })
    
    if (res.status === 400) {
      console.log(await res.json())
    }
    expect(res.status).toBe(200)
    expect(mockRunDDAgent).not.toHaveBeenCalled()
    expect(mockRunPlanningPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ ddReport: customDD })
    )
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
    expect(data.error).toMatch(/Invalid request body/)
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
    expect((await res.json()).error).toMatch(/Invalid request body/)
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

  it("returns 422 PLANNING_FAILED for an asset not in the HL universe", async () => {
    mockAssertAssetInUniverse.mockRejectedValue(
      new HyperliquidUniverseError("asset_not_found", "Asset DOGE not found in Hyperliquid universe")
    )

    const res = await post({ asset: "DOGE", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(mockAssertAssetInUniverse).toHaveBeenCalledWith("DOGE")
    expect(res.status).toBe(422)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.message).toBe("UNKNOWN_ASSET")
    expect(data.details.phase).toBe("dd")
    expect(mockRunDDAgent).not.toHaveBeenCalled()
    expect(mockRunPlanningPipeline).not.toHaveBeenCalled()
    expect(mockRecordDDFailure).toHaveBeenCalledTimes(1)
  })

  it("returns 502 PLANNING_FAILED when Hyperliquid is unreachable", async () => {
    mockAssertAssetInUniverse.mockRejectedValue(
      new HyperliquidUniverseError("unreachable", "Hyperliquid unreachable while validating BTC: ECONNRESET")
    )

    const res = await post({ asset: "BTC", userId: "user-1", walletAddress: "0x123" })
    const data = await res.json()

    expect(res.status).toBe(502)
    expect(data.error).toBe("PLANNING_FAILED")
    expect(data.message).toBe("HL_UNAVAILABLE")
    expect(data.details.phase).toBe("dd")
    expect(mockRunDDAgent).not.toHaveBeenCalled()
    expect(mockRunPlanningPipeline).not.toHaveBeenCalled()
    expect(mockRecordLLMFailure).toHaveBeenCalledTimes(1)
    expect(mockRecordDDFailure).not.toHaveBeenCalled()
  })
})
