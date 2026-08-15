/**
 * @file funding.test.ts
 * @description Tests for the funding-regime and OI/funding divergence tools.
 * Mocks lib/data/hyperliquid.ts so no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CandleData } from "@/lib/data/types"

const { mockCreateHLClient, mockFetchOnchainData, mockFetchMarkPrice, mockFetchCandles } = vi.hoisted(() => ({
  mockCreateHLClient: vi.fn(),
  mockFetchOnchainData: vi.fn(),
  mockFetchMarkPrice: vi.fn(),
  mockFetchCandles: vi.fn(),
}))

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: mockCreateHLClient,
  fetchOnchainData: mockFetchOnchainData,
  fetchMarkPrice: mockFetchMarkPrice,
  fetchCandles: mockFetchCandles,
}))

import { buildFundingTools } from "@/lib/agent/planning/tools/funding"

const CTX = { walletAddress: "0xabc", userId: "user_1", asset: "ETH", equity: 10000 }

const makeCandles = (closes: number[]): CandleData[] =>
  closes.map((close, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }))

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateHLClient.mockReturnValue({
    predictedFundings: vi.fn().mockResolvedValue([
      ["ETH", [["HlPerp", { fundingRate: "0.00012", nextFundingTime: 1710003600000, fundingIntervalHours: 1 }]]],
    ]),
  })
  mockFetchOnchainData.mockResolvedValue({
    fundingRate: 0.0001,
    openInterest: 1500000000,
    markPrice: 70500,
    oraclePrice: 70400,
    premium: 0.00005,
    dayVolume: 2000000000,
    oiCapReached: false,
  })
  mockFetchMarkPrice.mockResolvedValue(70500)
  mockFetchCandles.mockResolvedValue(makeCandles(Array(72).fill(70000)))
})

const tools = () => Object.fromEntries(buildFundingTools(CTX).map((t) => [t.name, t]))

describe("analyze_funding_regime", () => {
  it("flags overheated_long when funding is above +0.05%", async () => {
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.0006,
      openInterest: 1500000000,
      markPrice: 70500,
      oraclePrice: 70400,
      premium: 0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.regime).toBe("overheated_long")
    expect(result.data.fundingRate).toBe(0.0006)
    expect(result.data.openInterest).toBe(1500000000)
    expect(result.data.markPrice).toBe(70500)
    expect(result.data.predictedFunding).toBe(0.00012)
    expect(result.data.risk_flags).toEqual(["funding_overheated"])
    expect(result.metadata.source).toBe("hyperliquid")
  })

  it("flags overheated_short when funding is below -0.05%", async () => {
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: -0.0006,
      openInterest: 1500000000,
      markPrice: 70500,
      oraclePrice: 70400,
      premium: -0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.regime).toBe("overheated_short")
    expect(result.data.risk_flags).toEqual(["funding_overheated"])
  })

  it("returns normal for funding within threshold", async () => {
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.regime).toBe("normal")
    expect(result.data.risk_flags).toEqual([])
  })

  it("returns null predictedFunding when HlPerp venue is unavailable", async () => {
    mockCreateHLClient.mockReturnValueOnce({
      predictedFundings: vi.fn().mockResolvedValue([["ETH", [["BinPerp", { fundingRate: "0.0002", nextFundingTime: 1710003600000 }]]]]),
    })
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.predictedFunding).toBeNull()
  })

  it("tolerates predictedFundings endpoint failure", async () => {
    mockCreateHLClient.mockReturnValueOnce({
      predictedFundings: vi.fn().mockRejectedValue(new Error("endpoint down")),
    })
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.predictedFunding).toBeNull()
    expect(result.data.regime).toBe("normal")
  })

  it("falls back to fetchMarkPrice when ctx markPrice is invalid", async () => {
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.0001,
      openInterest: 1500000000,
      markPrice: 0,
      oraclePrice: 70400,
      premium: 0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.markPrice).toBe(70500)
    expect(mockFetchMarkPrice).toHaveBeenCalledWith("ETH")
  })

  it("returns success:false when onchain fetch fails", async () => {
    mockFetchOnchainData.mockRejectedValueOnce(new Error("API error"))
    const result = await tools().analyze_funding_regime.execute({ asset: "ETH" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("API error")
  })

  it("validates asset parameter", () => {
    expect(() => tools().analyze_funding_regime.parameters.parse({})).toThrow()
    expect(() => tools().analyze_funding_regime.parameters.parse({ asset: 123 })).toThrow()
  })
})

describe("detect_oi_funding_divergence", () => {
  it("flags divergence (bearish) when price is up but funding is strongly negative", async () => {
    mockFetchCandles.mockResolvedValueOnce(makeCandles([...Array(48).fill(70000), ...Array(24).fill(71000)]))
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: -0.0006,
      openInterest: 1500000000,
      markPrice: 71000,
      oraclePrice: 71000,
      premium: -0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.divergence).toBe(true)
    expect(result.data.signal).toBe("bearish")
    expect(result.data.risk_flags).toEqual(["oi_divergence"])
    expect(result.data.priceChangePct).toBeGreaterThan(0)
  })

  it("flags divergence (bullish) when price is down but funding is strongly positive", async () => {
    mockFetchCandles.mockResolvedValueOnce(makeCandles([...Array(48).fill(70000), ...Array(24).fill(69000)]))
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.0006,
      openInterest: 1500000000,
      markPrice: 69000,
      oraclePrice: 69000,
      premium: 0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.divergence).toBe(true)
    expect(result.data.signal).toBe("bullish")
    expect(result.data.risk_flags).toEqual(["oi_divergence"])
  })

  it("is neutral/overextended when price up + high OI turnover + strongly positive funding", async () => {
    mockFetchCandles.mockResolvedValueOnce(makeCandles([...Array(48).fill(70000), ...Array(24).fill(71000)]))
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: 0.0006,
      openInterest: 500000000,
      markPrice: 71000,
      oraclePrice: 71000,
      premium: 0.00005,
      dayVolume: 8000000000,
      oiCapReached: false,
    })
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.divergence).toBe(false)
    expect(result.data.signal).toBe("neutral")
    expect(result.data.oiChangePct).toBeGreaterThan(5)
  })

  it("is bullish when price up and funding mildly positive", async () => {
    mockFetchCandles.mockResolvedValueOnce(makeCandles([...Array(48).fill(70000), ...Array(24).fill(71000)]))
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.divergence).toBe(false)
    expect(result.data.signal).toBe("bullish")
  })

  it("is bearish when price down and funding negative", async () => {
    mockFetchCandles.mockResolvedValueOnce(makeCandles([...Array(48).fill(70000), ...Array(24).fill(69000)]))
    mockFetchOnchainData.mockResolvedValueOnce({
      fundingRate: -0.0002,
      openInterest: 1500000000,
      markPrice: 69000,
      oraclePrice: 69000,
      premium: -0.00005,
      dayVolume: 2000000000,
      oiCapReached: false,
    })
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.signal).toBe("bearish")
  })

  it("is neutral when no price move and funding near zero", async () => {
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.divergence).toBe(false)
    expect(result.data.signal).toBe("neutral")
    expect(result.data.risk_flags).toEqual([])
  })

  it("returns success:false when candles fetch fails", async () => {
    mockFetchCandles.mockRejectedValueOnce(new Error("candle API error"))
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("candle API error")
  })

  it("notes explain the OI-change approximation", async () => {
    const result = await tools().detect_oi_funding_divergence.execute({ asset: "ETH" })
    expect(result.success).toBe(true)
    expect(result.data.notes).toContain("approximation")
  })

  it("validates asset parameter", () => {
    expect(() => tools().detect_oi_funding_divergence.parameters.parse({})).toThrow()
  })
})
