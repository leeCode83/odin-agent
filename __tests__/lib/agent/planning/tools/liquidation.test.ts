/**
 * @file liquidation.test.ts
 * @description Tests for the liquidation-zone and cascade-risk approximation
 * tools. Mocks the orderbook tool and lib/data/hyperliquid.ts so no network
 * calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCreateHLClient, mockFetchOnchainData, mockBookExecute } = vi.hoisted(() => ({
  mockCreateHLClient: vi.fn(),
  mockFetchOnchainData: vi.fn(),
  mockBookExecute: vi.fn(),
}))

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: mockCreateHLClient,
  fetchOnchainData: mockFetchOnchainData,
  fetchMarkPrice: vi.fn(),
  fetchCandles: vi.fn(),
}))

vi.mock("@/lib/agent/tools/onchain/hyperliquid", () => ({
  getOrderbookDepthTool: vi.fn(() => ({ execute: mockBookExecute })),
}))

import { buildLiquidationTools } from "@/lib/agent/planning/tools/liquidation"

const CTX = { walletAddress: "0xabc", userId: "user_1", asset: "ETH", equity: 10000 }

const mockBook = (bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>, midPrice: number) =>
  mockBookExecute.mockResolvedValue({
    success: true,
    data: { asset: "ETH", midPrice, bids, asks },
    metadata: { source: "hyperliquid", latencyMs: 1 },
  })

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateHLClient.mockReturnValue({})
  mockFetchOnchainData.mockResolvedValue({
    fundingRate: 0.0001,
    openInterest: 1500000000,
    markPrice: 70000,
    oraclePrice: 70000,
    premium: 0.00005,
    dayVolume: 2000000000,
    oiCapReached: false,
  })
})

const tools = () => Object.fromEntries(buildLiquidationTools(CTX).map((t) => [t.name, t]))

describe("check_liquidation_zones", () => {
  it("warns when stopLoss sits within 0.5% of a liquidity cluster", async () => {
    mockBook(
      [
        { price: 70000, size: 100 },
        { price: 69980, size: 200 },
        { price: 69000, size: 50 },
      ],
      [
        { price: 70500, size: 100 },
        { price: 70520, size: 200 },
        { price: 71000, size: 50 },
      ],
      70250
    )
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 69900 })
    expect(result.success).toBe(true)
    expect(result.data.warning).toBe(true)
    expect(result.data.zones.length).toBeGreaterThan(0)
  })

  it("does not warn when stopLoss is far from any cluster", async () => {
    mockBook(
      [{ price: 70000, size: 100 }],
      [{ price: 70500, size: 100 }],
      70250
    )
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 68000 })
    expect(result.success).toBe(true)
    expect(result.data.warning).toBe(false)
  })

  it("returns bid and ask cluster zones with labels", async () => {
    mockBook(
      [
        { price: 70000, size: 100 },
        { price: 69980, size: 200 },
      ],
      [{ price: 70500, size: 100 }],
      70250
    )
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 68000 })
    expect(result.success).toBe(true)
    const labels = result.data.zones.map((z: { label: string }) => z.label)
    expect(labels.some((l: string) => l.includes("bid"))).toBe(true)
    expect(labels.some((l: string) => l.includes("ask"))).toBe(true)
  })

  it("labels itself approximation in description and notes", async () => {
    mockBook([{ price: 70000, size: 100 }], [{ price: 70500, size: 100 }], 70250)
    expect(tools().check_liquidation_zones.description).toContain("approximation")
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 69900 })
    expect(result.success).toBe(true)
    expect(result.data.notes).toContain("approximation")
  })

  it("returns empty zones when orderbook has no levels", async () => {
    mockBook([], [], 70250)
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 69900 })
    expect(result.success).toBe(true)
    expect(result.data.warning).toBe(false)
    expect(result.data.zones).toEqual([])
  })

  it("returns success:false when the orderbook tool fails", async () => {
    mockBookExecute.mockResolvedValueOnce({ success: false, error: "book API error", metadata: { source: "hyperliquid", latencyMs: 1 } })
    const result = await tools().check_liquidation_zones.execute({ asset: "ETH", entryPrice: 70250, stopLoss: 69900 })
    expect(result.success).toBe(false)
    expect(result.error).toContain("book API error")
  })

  it("validates parameters", () => {
    expect(() => tools().check_liquidation_zones.parameters.parse({ asset: "ETH" })).toThrow()
    expect(() => tools().check_liquidation_zones.parameters.parse({ asset: "ETH", entryPrice: "x", stopLoss: 1 })).toThrow()
  })
})

describe("assess_cascade_risk", () => {
  it("returns high when funding extreme + large OI + thin orderbook", async () => {
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.001,
      openInterest: 300000000,
      markPrice: 70000,
      oraclePrice: 70000,
      premium: 0.0001,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    mockBook([{ price: 70000, size: 0.1 }], [{ price: 70010, size: 0.1 }], 70000)
    const result = await tools().assess_cascade_risk.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.cascadeRisk).toBe("high")
  })

  it("returns medium when funding elevated + large OI but deep book", async () => {
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.0006,
      openInterest: 300000000,
      markPrice: 70000,
      oraclePrice: 70000,
      premium: 0.0001,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    mockBook([{ price: 70000, size: 10000 }], [{ price: 70010, size: 10000 }], 70000)
    const result = await tools().assess_cascade_risk.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.cascadeRisk).toBe("medium")
  })

  it("returns low when funding calm + moderate OI + deep book", async () => {
    mockBook([{ price: 70000, size: 10000 }], [{ price: 70010, size: 10000 }], 70000)
    const result = await tools().assess_cascade_risk.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.cascadeRisk).toBe("low")
  })

  it("labels itself approximation in description and notes", async () => {
    mockBook([{ price: 70000, size: 10000 }], [{ price: 70010, size: 10000 }], 70000)
    expect(tools().assess_cascade_risk.description).toContain("approximation")
    const result = await tools().assess_cascade_risk.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.notes).toContain("approximation")
  })

  it("returns success:false when onchain fetch fails", async () => {
    mockFetchOnchainData.mockRejectedValueOnce(new Error("API error"))
    const result = await tools().assess_cascade_risk.execute({ asset: "ETH" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })

  it("validates asset parameter", () => {
    expect(() => tools().assess_cascade_risk.parameters.parse({})).toThrow()
  })
})
