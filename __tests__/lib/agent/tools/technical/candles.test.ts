import { describe, it, expect, vi, beforeEach } from "vitest"
import { getTimeframeCandles, type CandleMap } from "@/lib/agent/tools/technical/candles"
import type { CandleData } from "@/lib/data/types"

const makeCandles = (n: number): CandleData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000 + i * 10,
  }))

describe("getTimeframeCandles", () => {
  it("returns candles for existing timeframe", () => {
    const candles1h = makeCandles(10)
    const map: CandleMap = { "1h": candles1h, "15m": [], "1d": [] }
    expect(getTimeframeCandles("1h", map)).toHaveLength(10)
    expect(getTimeframeCandles("1h", map)).toBe(candles1h)
  })

  it("returns empty array for missing timeframe", () => {
    const map: CandleMap = { "1h": makeCandles(5), "15m": [], "1d": [] }
    expect(getTimeframeCandles("4h", map)).toEqual([])
  })

  it("returns empty array when map is empty", () => {
    const map: CandleMap = { "1h": [], "15m": [], "1d": [] }
    expect(getTimeframeCandles("1h", map)).toEqual([])
  })
})

describe("fetchCandleMap", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("fetches 3 timeframes in parallel and returns CandleMap", async () => {
    const mockCandles1h = makeCandles(200)
    const mockCandles15m = makeCandles(200)
    const mockCandles1d = makeCandles(100)

    const mockFetchCandlesByInterval = vi.fn()
    mockFetchCandlesByInterval.mockResolvedValueOnce(mockCandles1h)
    mockFetchCandlesByInterval.mockResolvedValueOnce(mockCandles15m)
    mockFetchCandlesByInterval.mockResolvedValueOnce(mockCandles1d)

    vi.doMock("@/lib/data/hyperliquid", () => ({
      createHLClient: vi.fn(),
      fetchCandlesByInterval: mockFetchCandlesByInterval,
    }))

    const { fetchCandleMap } = await import("@/lib/agent/tools/technical/candles")
    const result = await fetchCandleMap("BTC")

    expect(mockFetchCandlesByInterval).toHaveBeenCalledTimes(3)
    expect(result["1h"]).toHaveLength(200)
    expect(result["15m"]).toHaveLength(200)
    expect(result["1d"]).toHaveLength(100)
    expect(Object.keys(result)).toEqual(["1h", "15m", "1d"])
  })

  it("returns empty array for timeframe that fails to fetch", async () => {
    const mockCandles1h = makeCandles(200)
    const mockFetchCandlesByInterval = vi.fn()
    mockFetchCandlesByInterval.mockResolvedValueOnce(mockCandles1h)
    mockFetchCandlesByInterval.mockRejectedValueOnce(new Error("API error"))
    mockFetchCandlesByInterval.mockRejectedValueOnce(new Error("API error"))

    vi.doMock("@/lib/data/hyperliquid", () => ({
      createHLClient: vi.fn(),
      fetchCandlesByInterval: mockFetchCandlesByInterval,
    }))

    const { fetchCandleMap } = await import("@/lib/agent/tools/technical/candles")
    const result = await fetchCandleMap("ETH")

    expect(result["1h"]).toHaveLength(200)
    expect(result["15m"]).toEqual([])
    expect(result["1d"]).toEqual([])
  })

  it("uses correct window sizes for each timeframe", async () => {
    const mockFetchCandlesByInterval = vi.fn().mockResolvedValue(makeCandles(10))
    vi.doMock("@/lib/data/hyperliquid", () => ({
      createHLClient: vi.fn(),
      fetchCandlesByInterval: mockFetchCandlesByInterval,
    }))

    const { fetchCandleMap } = await import("@/lib/agent/tools/technical/candles")
    await fetchCandleMap("SOL")

    const calls = mockFetchCandlesByInterval.mock.calls
    expect(calls).toHaveLength(3)

    // 1h: interval="1h", window=200*3600000
    expect(calls[0][2]).toBe("1h")
    expect(calls[0][3]).toBeLessThanOrEqual(Date.now() - 200 * 3600000 + 1000)
    // 15m: interval="15m", window=200*900000
    expect(calls[1][2]).toBe("15m")
    expect(calls[1][3]).toBeLessThanOrEqual(Date.now() - 200 * 900000 + 1000)
    // 1d: interval="1d", window=100*86400000
    expect(calls[2][2]).toBe("1d")
    expect(calls[2][3]).toBeLessThanOrEqual(Date.now() - 100 * 86400000 + 1000)
  })
})
