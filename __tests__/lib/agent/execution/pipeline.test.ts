import { describe, it, expect, vi, beforeEach } from "vitest"
import { runExecutionPipeline } from "@/lib/agent/execution/pipeline"
import type { TradePlan, DDReport } from "@/lib/agent/types"

const mockExchangeClient = { updateLeverage: vi.fn(), order: vi.fn() }

const { mockGetAgentSigner, mockGetExchangeClient, mockGetAssetIndex, mockBuildOrders, mockRecordGraphMemory, mockSubscribeFill } = vi.hoisted(() => ({
  mockGetAgentSigner: vi.fn(() => ({ address: "0xagent" })),
  mockGetExchangeClient: vi.fn(() => mockExchangeClient),
  mockGetAssetIndex: vi.fn().mockResolvedValue({ assetIndex: 0, szDecimals: 5 }),
  mockBuildOrders: vi.fn(() => ({
    entry: { a: 0, b: true, p: "65000", s: "0.001", r: false, t: { limit: { tif: "Gtc" } } },
    takeProfit: { a: 0, b: false, p: "68000", s: "0.001", r: true, t: { trigger: { isMarket: false, triggerPx: "68000", tpsl: "tp" } } },
    stopLoss: { a: 0, b: false, p: "64000", s: "0.001", r: true, t: { trigger: { isMarket: false, triggerPx: "64000", tpsl: "sl" } } },
  })),
  mockRecordGraphMemory: vi.fn(),
  mockSubscribeFill: vi.fn(),
}))

vi.mock("@/lib/agent/execution/client", () => ({
  getAgentSigner: mockGetAgentSigner,
  getExchangeClient: mockGetExchangeClient,
  getAssetIndex: mockGetAssetIndex,
}))
vi.mock("@/lib/agent/execution/orders", () => ({
  buildOrders: mockBuildOrders,
}))
vi.mock("@/lib/agent/execution/ws-monitor", () => ({
  subscribeFill: mockSubscribeFill,
}))
vi.mock("@/lib/db/graph-memory", () => ({
  recordGraphMemory: mockRecordGraphMemory,
}))

const validTradePlan: TradePlan = {
  asset: "BTC",
  side: "long",
  entry_price: 65000,
  position_size_usdc: 50,
  position_size_contracts: 0.001,
  stop_loss: 64000,
  take_profit: 68000,
  leverage: 3,
  confidence_score: 75,
  confidence_breakdown: { factor_alignment: 75, historical_match: 60, signal_strength: 80 },
  thesis: "BTC bullish",
  reasoning: "Technical strength",
  autonomy_decision: "auto",
  risk_flags: [],
  graph_patterns_used: [],
  timestamp: "2026-07-20T10:00:00Z",
}

const mockDDReport: DDReport = {
  asset: "BTC",
  category: "major",
  timestamp: "2026-07-20T10:00:00Z",
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

const OLD_ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  process.env = { ...OLD_ENV, AGENT_PRIVATE_KEY: "0xagent-test-key" }
  mockExchangeClient.updateLeverage = vi.fn()
  mockExchangeClient.order = vi.fn().mockResolvedValue({
    response: {
      data: {
        statuses: [
          { resting: { oid: 100 } },
          { resting: { oid: 101 } },
          { resting: { oid: 102 } },
        ],
      },
    },
  })
  mockSubscribeFill.mockResolvedValue([
    { status: "filled", fillAmount: "0.001", fillPrice: "65000", oid: 100 },
  ])
  mockRecordGraphMemory.mockResolvedValue("abc123")
})

describe("runExecutionPipeline", () => {
  it("returns ExecutionPipelineOutput with placed orders and fill status", async () => {
    const output = await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(output.execution).toBeDefined()
    expect(output.execution.status).toBe("placed")
    expect(output.execution.orders).toHaveLength(3)
    expect(output.execution.orders[0]).toMatchObject({ type: "entry", oid: 100 })
    expect(output.execution.orders[1]).toMatchObject({ type: "take_profit", oid: 101 })
    expect(output.execution.orders[2]).toMatchObject({ type: "stop_loss", oid: 102 })
    expect(output.execution.fillStatus).toBe("partial")
    expect(output.execution.fillAmount).toBe("0.001")
    expect(output.execution.decisionKey).toBe("abc123")
    expect(output.timing.totalMs).toBeGreaterThanOrEqual(0)
  })

  it("reports filled when all orders fill", async () => {
    mockSubscribeFill.mockResolvedValue([
      { status: "filled", fillAmount: "0.001", fillPrice: "65000", oid: 100 },
      { status: "filled", fillAmount: "0.001", fillPrice: "68000", oid: 101 },
      { status: "filled", fillAmount: "0.001", fillPrice: "64000", oid: 102 },
    ])

    const output = await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(output.execution.fillStatus).toBe("filled")
  })

  it("reports none when no fills", async () => {
    mockSubscribeFill.mockResolvedValue([
      { status: "none", oid: 100 },
      { status: "none", oid: 101 },
      { status: "none", oid: 102 },
    ])

    const output = await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(output.execution.fillStatus).toBe("none")
  })

  it("resolves asset index before building orders", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(mockGetAssetIndex).toHaveBeenCalledWith("BTC")
    expect(mockBuildOrders).toHaveBeenCalledWith(validTradePlan, 0, 5)
  })

  it("sets leverage with correct asset index", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(mockExchangeClient.updateLeverage).toHaveBeenCalledWith({
      asset: 0,
      isCross: true,
      leverage: 3,
    })
  })

  it("throws ExecutionError when autonomy_decision is approve", async () => {
    await expect(
      runExecutionPipeline({
        tradePlan: { ...validTradePlan, autonomy_decision: "approve" },
        walletAddress: "0xmaster",
        userId: "user-1",
      })
    ).rejects.toThrow("TradePlan requires manual approval")
  })

  it("throws ExecutionError when AGENT_PRIVATE_KEY missing", async () => {
    process.env.AGENT_PRIVATE_KEY = ""
    await expect(
      runExecutionPipeline({
        tradePlan: validTradePlan,
        walletAddress: "0xmaster",
        userId: "user-1",
      })
    ).rejects.toThrow("Agent wallet not initialized")
  })

  it("calls subscribeFill with order IDs", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(mockSubscribeFill).toHaveBeenCalledWith([100, 101, 102], 15_000)
  })

  it("records graph memory with signals when ddReport provided", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
      ddReport: mockDDReport,
    })

    expect(mockRecordGraphMemory).toHaveBeenCalled()
    const callArg = mockRecordGraphMemory.mock.calls[0][0]
    expect(callArg.userId).toBe("user-1")
    expect(callArg.asset).toBe("BTC")
    expect(callArg.signals).toHaveLength(1)
    expect(callArg.signals[0]).toMatchObject({ factor: "technical", signalType: "RSI > 60" })
  })

  it("records graph memory without signals when ddReport absent", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(mockRecordGraphMemory).toHaveBeenCalled()
    const callArg = mockRecordGraphMemory.mock.calls[0][0]
    expect(callArg.signals).toEqual([])
  })

  it("does not fail pipeline when graph recording fails", async () => {
    mockRecordGraphMemory.mockRejectedValue(new Error("DB down"))

    const output = await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(output.execution.status).toBe("placed")
    expect(output.execution.decisionKey).toBeUndefined()
  })

  it("places orders with correct grouping", async () => {
    await runExecutionPipeline({
      tradePlan: validTradePlan,
      walletAddress: "0xmaster",
      userId: "user-1",
    })

    expect(mockExchangeClient.order).toHaveBeenCalledWith({
      orders: expect.arrayContaining([
        expect.objectContaining({ a: 0 }),
      ]),
      grouping: "normalTpsl",
    })
  })
})
