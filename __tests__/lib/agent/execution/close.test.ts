/**
 * @file close.test.ts
 * @description Unit tests for closeAllPositions and closePositionForCoin.
 * Mocks @nktkas/hyperliquid, client module, graph-memory, and utils.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockClearinghouseState = vi.fn()
const mockAllMids = vi.fn()
const mockMetaAndAssetCtxs = vi.fn()
const mockOpenOrders = vi.fn()
const mockCancel = vi.fn()
const mockOrder = vi.fn()
const mockRecordOutcome = vi.fn()
const mockFormatPrice = vi.fn((p: number) => String(p))
const mockFormatSize = vi.fn((s: string | number) => String(s))

vi.mock("@nktkas/hyperliquid", () => {
  class MockInfoClient {
    clearinghouseState = mockClearinghouseState
    allMids = mockAllMids
    metaAndAssetCtxs = mockMetaAndAssetCtxs
    openOrders = mockOpenOrders
  }
  class MockExchangeClient {
    order = mockOrder
    cancel = mockCancel
  }
  class MockHttpTransport {}
  return {
    InfoClient: MockInfoClient,
    ExchangeClient: MockExchangeClient,
    HttpTransport: MockHttpTransport,
  }
})

vi.mock("@nktkas/hyperliquid/utils", () => ({
  formatPrice: mockFormatPrice,
  formatSize: mockFormatSize,
}))

vi.mock("@/lib/agent/execution/client", () => ({
  getAgentSigner: vi.fn(() => ({ address: "0xagent" })),
  getExchangeClient: vi.fn(() => ({
    order: mockOrder,
    cancel: mockCancel,
  })),
  getAssetIndex: vi.fn().mockResolvedValue({ assetIndex: 0, szDecimals: 5 }),
}))

vi.mock("@/lib/db/graph-memory", () => ({
  recordOutcome: mockRecordOutcome,
}))

vi.mock("@/lib/utils", () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
  withTimeout: vi.fn((promise: Promise<unknown>) => promise),
}))

const OLD_ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  process.env = { ...OLD_ENV, AGENT_PRIVATE_KEY: "0xkey", AGENT_WALLET_ADDRESS: "0xaddr" }
  mockClearinghouseState.mockResolvedValue({
    assetPositions: [
      { position: { coin: "BTC", szi: "0.1" } },
      { position: { coin: "ETH", szi: "-2.0" } },
    ],
  })
  mockAllMids.mockResolvedValue({ BTC: "65000", ETH: "3200" })
  mockMetaAndAssetCtxs.mockResolvedValue([{ universe: [{ name: "BTC" }, { name: "ETH" }] }])
  mockOpenOrders.mockResolvedValue([])
  mockOrder.mockResolvedValue({ response: { data: { statuses: [{ resting: { oid: 100 } }] } } })
  mockCancel.mockResolvedValue(undefined)
  mockRecordOutcome.mockResolvedValue("outcome_key")
})

describe("closeAllPositions", () => {
  it("returns closed:0 when no positions", async () => {
    mockClearinghouseState.mockResolvedValue({})
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    const result = await closeAllPositions()
    expect(result.closed).toBe(0)
    expect(result.positions).toEqual([])
  })

  it("closes a long BTC position with sell IoC", async () => {
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    const result = await closeAllPositions()

    expect(result.closed).toBeGreaterThan(0)
    expect(result.positions[0]).toMatchObject({ coin: "BTC", side: "long", closed: true })
    const orderCall = mockOrder.mock.calls[0][0]
    expect(orderCall.orders[0].b).toBe(false)
    expect(orderCall.orders[0].r).toBe(true)
    expect(orderCall.orders[0].t.limit.tif).toBe("Ioc")
  })

  it("closes a short ETH position with buy IoC", async () => {
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    const result = await closeAllPositions()

    expect(result.positions[1]).toMatchObject({ coin: "ETH", side: "short", closed: true })
    const orderCall = mockOrder.mock.calls[1][0]
    expect(orderCall.orders[0].b).toBe(true)
  })

  it("cancels open orders before closing", async () => {
    mockOpenOrders.mockResolvedValue([
      { coin: "BTC", oid: 10, sz: "0.1", limitPx: "65000", side: "A" },
    ])
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    await closeAllPositions()

    expect(mockCancel).toHaveBeenCalled()
  })

  it("handles graph memory failure gracefully", async () => {
    mockRecordOutcome.mockRejectedValue(new Error("DB down"))
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    const result = await closeAllPositions()
    expect(result.closed).toBeGreaterThan(0)
  })

  it("returns error when mid price missing", async () => {
    mockAllMids.mockResolvedValue({ BTC: "65000" })
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    const result = await closeAllPositions()
    const ethResult = result.positions.find((p: { coin: string }) => p.coin === "ETH")
    expect(ethResult?.error).toBeDefined()
    expect(ethResult?.closed).toBe(false)
  })

  it("throws when AGENT_PRIVATE_KEY missing", async () => {
    process.env.AGENT_PRIVATE_KEY = ""
    const { closeAllPositions } = await import("@/lib/agent/execution/close")
    await expect(closeAllPositions()).rejects.toThrow("Agent wallet not initialized")
  })
})

describe("closePositionForCoin", () => {
  it("closes position for specified coin", async () => {
    const { closePositionForCoin } = await import("@/lib/agent/execution/close")
    const result = await closePositionForCoin("BTC")
    expect(result.closed).toBe(1)
    expect(result.positions[0].coin).toBe("BTC")
  })

  it("returns closed:0 when coin has no position", async () => {
    const { closePositionForCoin } = await import("@/lib/agent/execution/close")
    const result = await closePositionForCoin("SOL")
    expect(result.closed).toBe(0)
    expect(result.positions).toEqual([])
  })

  it("accepts explicit agentPk and agentAddr parameters", async () => {
    const { closePositionForCoin } = await import("@/lib/agent/execution/close")
    const result = await closePositionForCoin("BTC", "0xkey2", "0xaddr2")
    expect(result.closed).toBe(1)
  })
})
