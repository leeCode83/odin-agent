import { describe, it, expect, beforeAll } from "vitest"
import type { CandleMap } from "@/lib/agent/due-diligence/tools/technical/candles"
import type { CandleData } from "@/lib/data/types"
import type { ToolDefinition } from "@/lib/agent/due-diligence/tools/types"

function makeTrendCandles(n: number, startPrice = 100, uptrend = true): CandleData[] {
  const dir = uptrend ? 1 : -1
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: startPrice + dir * i,
    high: startPrice + dir * i + 5,
    low: startPrice + dir * i - 5,
    close: startPrice + dir * i + dir,
    volume: 1000 + i * 10,
  }))
}

function makeVolatileCandles(n: number): CandleData[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: 100 + Math.sin(i * 0.5) * 10,
    high: 100 + Math.sin(i * 0.5) * 10 + 8 + Math.random() * 5,
    low: 100 + Math.sin(i * 0.5) * 10 - 8 - Math.random() * 5,
    close: 100 + Math.sin(i * 0.5) * 10 + (Math.random() - 0.5) * 6,
    volume: 1000 + Math.abs(Math.sin(i * 0.3)) * 500,
  }))
}

describe("buildIndicators", () => {
  const candleMap: CandleMap = {
    "1h": makeTrendCandles(220),
    "15m": makeTrendCandles(220),
    "1d": makeTrendCandles(120, 1000),
  }

  let tools: ToolDefinition[]

  beforeAll(async () => {
    const { buildIndicators } = await import("@/lib/agent/due-diligence/tools/technical/indicators")
    tools = buildIndicators(candleMap)
  })

  it("get_rsi returns RSI values", async () => {
    const tool = tools.find((t) => t.name === "get_rsi")!
    const result = await tool.execute({ period: 14, timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as { values: number[]; latest: number | null }
    expect(Array.isArray(data.values)).toBe(true)
    expect(data.values.length).toBeGreaterThan(0)
    expect(data.values.every((v) => v >= 0 && v <= 100)).toBe(true)
  })

  it("get_rsi returns error with insufficient candles", async () => {
    const emptyMap: CandleMap = { "1h": [], "15m": [], "1d": [] }
    const { buildIndicators } = await import("@/lib/agent/due-diligence/tools/technical/indicators")
    const localTools = buildIndicators(emptyMap)
    const tool = localTools.find((t) => t.name === "get_rsi")!
    const result = await tool.execute({ period: 14, timeframe: "1h" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Not enough candles")
  })

  it("get_macd returns MACDOutput values", async () => {
    const tool = tools.find((t) => t.name === "get_macd")!
    const result = await tool.execute({ fast: 12, slow: 26, signal: 9, timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as {
      values: Array<Record<string, number | undefined>>
      latest: Record<string, number | null> | null
    }
    expect(Array.isArray(data.values)).toBe(true)
    expect(data.values.length).toBeGreaterThan(0)
    expect(data.values[data.values.length - 1]).toHaveProperty("MACD")
  })

  it("get_ema returns EMA values", async () => {
    const tool = tools.find((t) => t.name === "get_ema")!
    const result = await tool.execute({ period: 20, timeframe: "1h" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as number[]).length).toBeGreaterThan(0)
  })

  it("get_sma returns SMA values", async () => {
    const tool = tools.find((t) => t.name === "get_sma")!
    const result = await tool.execute({ period: 20, timeframe: "1h" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as number[]).length).toBeGreaterThan(0)
  })

  it("get_bb returns Bollinger Bands", async () => {
    const tool = tools.find((t) => t.name === "get_bb")!
    const result = await tool.execute({ period: 20, stddev: 2, timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as {
      values: Array<Record<string, number>>
      latest: Record<string, number> | null
    }
    expect(data.values.length).toBeGreaterThan(0)
    const last = data.values[data.values.length - 1]
    expect(last).toHaveProperty("upper")
    expect(last).toHaveProperty("middle")
    expect(last).toHaveProperty("lower")
    expect(last.upper).toBeGreaterThan(last.middle)
    expect(last.middle).toBeGreaterThan(last.lower)
  })

  it("get_atr returns ATR values", async () => {
    const volatileMap: CandleMap = {
      "1h": makeVolatileCandles(30),
      "15m": [],
      "1d": [],
    }
    const { buildIndicators } = await import("@/lib/agent/due-diligence/tools/technical/indicators")
    const localTools = buildIndicators(volatileMap)
    const tool = localTools.find((t) => t.name === "get_atr")!
    const result = await tool.execute({ period: 14, timeframe: "1h" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as number[]).length).toBeGreaterThan(0)
    expect((result.data as number[]).every((v) => v > 0)).toBe(true)
  })

  it("get_stoch returns Stochastic values", async () => {
    const tool = tools.find((t) => t.name === "get_stoch")!
    const result = await tool.execute({ k: 14, d: 3, timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as {
      values: Array<Record<string, number | undefined>>
      latest: Record<string, number | null> | null
    }
    expect(data.values.length).toBeGreaterThan(0)
    const last = data.values[data.values.length - 1]
    expect(last).toHaveProperty("k")
  })

  it("get_obv returns OBV values", async () => {
    const tool = tools.find((t) => t.name === "get_obv")!
    const result = await tool.execute({ timeframe: "1h" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data as number[]).length).toBeGreaterThan(0)
  })

  it("get_ichimoku returns IchimokuCloud values", async () => {
    const tool = tools.find((t) => t.name === "get_ichimoku")!
    const result = await tool.execute({ tenkan: 9, kijun: 26, senkou: 52, timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as Array<Record<string, number | undefined>>
    expect(data.length).toBeGreaterThan(0)
    const last = data[data.length - 1]
    expect(last).toHaveProperty("conversion")
  })

  it("get_volume returns volume analysis", async () => {
    const tool = tools.find((t) => t.name === "get_volume")!
    const result = await tool.execute({ timeframe: "1h" })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data).toHaveProperty("avgVolume")
    expect(data).toHaveProperty("currentVolume")
    expect(data).toHaveProperty("volumeRatio")
    expect(data).toHaveProperty("trend")
  })

  it("get_support_resistance returns swing levels", async () => {
    const tool = tools.find((t) => t.name === "get_support_resistance")!
    const result = await tool.execute({ timeframe: "1h", lookback: 10 })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, number[]>
    expect(data).toHaveProperty("support")
    expect(data).toHaveProperty("resistance")
    expect(Array.isArray(data.support)).toBe(true)
    expect(Array.isArray(data.resistance)).toBe(true)
  })

  it("get_fibonacci returns fibonacci levels", async () => {
    const tool = tools.find((t) => t.name === "get_fibonacci")!
    const result = await tool.execute({ timeframe: "1d", lookback: 30 })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, number>
    expect(data).toHaveProperty("high")
    expect(data).toHaveProperty("low")
    expect(data).toHaveProperty("level_0.236")
    expect(data).toHaveProperty("level_0.382")
    expect(data).toHaveProperty("level_0.5")
    expect(data).toHaveProperty("level_0.618")
    expect(data).toHaveProperty("level_0.786")
  })

  it("get_divergence returns divergence analysis", async () => {
    const tool = tools.find((t) => t.name === "get_divergence")!
    const result = await tool.execute({
      timeframe: "1h",
      indicator: "rsi",
      period: 14,
      lookback: 20,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data).toHaveProperty("regularBearish")
    expect(data).toHaveProperty("regularBullish")
  })

  it("all tools return valid metadata", async () => {
    for (const tool of tools) {
      const result = await tool.execute({ timeframe: "1h", ...getDefaultParams(tool.name) })
      expect(result.metadata).toBeDefined()
      expect(typeof result.metadata.source).toBe("string")
      expect(typeof result.metadata.latencyMs).toBe("number")
    }
  })
})

function getDefaultParams(name: string): Record<string, unknown> {
  switch (name) {
    case "get_rsi": return { period: 14 }
    case "get_macd": return { fast: 12, slow: 26, signal: 9 }
    case "get_ema": return { period: 20 }
    case "get_sma": return { period: 20 }
    case "get_bb": return { period: 20, stddev: 2 }
    case "get_atr": return { period: 14 }
    case "get_stoch": return { k: 14, d: 3 }
    case "get_obv": return {}
    case "get_ichimoku": return { tenkan: 9, kijun: 26, senkou: 52 }
    case "get_volume": return {}
    case "get_support_resistance": return { lookback: 10 }
    case "get_fibonacci": return { lookback: 30 }
    case "get_divergence": return { indicator: "rsi", period: 14, lookback: 20 }
    default: return {}
  }
}
