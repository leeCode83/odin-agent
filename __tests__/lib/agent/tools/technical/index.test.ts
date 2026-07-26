import { describe, it, expect } from "vitest"
import type { ToolRegistry } from "@/lib/agent/tools/types"
import type { CandleMap } from "@/lib/agent/tools/technical/candles"
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

describe("buildTechnicalRegistry", () => {
  it("returns a ToolRegistry with all 13 tools", async () => {
    const { buildTechnicalRegistry } = await import("@/lib/agent/tools/technical")

    const candleMap: CandleMap = {
      "1h": makeCandles(220),
      "15m": makeCandles(220),
      "1d": makeCandles(120),
    }

    const registry: ToolRegistry = buildTechnicalRegistry(candleMap)
    const names = Object.keys(registry).sort()

    expect(names).toEqual([
      "get_atr",
      "get_bb",
      "get_divergence",
      "get_ema",
      "get_fibonacci",
      "get_ichimoku",
      "get_macd",
      "get_obv",
      "get_rsi",
      "get_sma",
      "get_stoch",
      "get_support_resistance",
      "get_volume",
    ])

    for (const name of names) {
      const tool = registry[name]
      expect(tool.name).toBe(name)
      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe("function")
    }
  })

  it("all tool execute methods work with default parameters", async () => {
    const { buildTechnicalRegistry } = await import("@/lib/agent/tools/technical")

    const candleMap: CandleMap = {
      "1h": makeCandles(220),
      "15m": makeCandles(220),
      "1d": makeCandles(120),
    }

    const registry = buildTechnicalRegistry(candleMap)

    for (const tool of Object.values(registry)) {
      const params = tool.parameters.parse({})
      const result = await tool.execute(params)
      expect(result.success).toBe(true)
      expect(result.metadata.source).toBe("technicalindicators")
      expect(typeof result.metadata.latencyMs).toBe("number")
      expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })
})
