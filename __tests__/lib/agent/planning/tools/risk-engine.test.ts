import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import type { CandleData } from "@/lib/data/types"

// Mock hyperliquid module; hoisted before any imports resolve
const mockFetchCandlesForATR = vi.hoisted(() => vi.fn())
const mockFetchMarkPrice = vi.hoisted(() => vi.fn())
vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(() => ({})),
  fetchCandlesForATR: mockFetchCandlesForATR,
  fetchMarkPrice: mockFetchMarkPrice,
}))

import { buildRiskEngineTools } from "@/lib/agent/planning/tools/risk-engine"

// 15 candles with constant TR=10 -> ATR = 10 for any period <= 14
const makeFlatCandles = (n: number): CandleData[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: 1710000000000 + i * 3600000,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 1000,
  }))

const CTX = { asset: "ETH" }

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchCandlesForATR.mockResolvedValue(makeFlatCandles(20))
  mockFetchMarkPrice.mockResolvedValue(200)
})

describe("compute_atr", () => {
  it("returns ATR, atrPercentOfEntry, and source hyperliquid", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_atr")
    const params = tool.parameters.parse({ asset: "BTC" })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    // ATR of flat candles is 10; mark price 200 -> 5% of entry
    expect(result.data).toEqual({ atr: 10, atrPercentOfEntry: 5, source: "hyperliquid" })
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("BTC", "1h", 20)
    expect(mockFetchMarkPrice).toHaveBeenCalledWith("BTC")
    expect(result.metadata.source).toBe("hyperliquid")
  })

  it("honors custom period and fetches 20 candles at 1h regardless", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_atr")
    const params = tool.parameters.parse({ asset: "BTC", period: 3 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data.atr).toBe(10)
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("BTC", "1h", 20)
  })

  it("falls back to ctx.asset when params omit asset", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_atr")
    const params = tool.parameters.parse({})
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(mockFetchCandlesForATR).toHaveBeenCalledWith("ETH", "1h", 20)
  })

  it("returns success:false when mark price fetch fails", async () => {
    mockFetchMarkPrice.mockRejectedValue(new Error("API down"))
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_atr")
    const params = tool.parameters.parse({ asset: "BTC" })
    const result = await tool.execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toBe("API down")
  })

  it("returns success:false when candles are insufficient for ATR", async () => {
    mockFetchCandlesForATR.mockResolvedValue(makeFlatCandles(5))
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_atr")
    const params = tool.parameters.parse({ asset: "BTC" })
    const result = await tool.execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toContain("Insufficient candles")
  })
})

describe("compute_sltp", () => {
  it("long: default multipliers (1.5 / 3.0)", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_sltp")
    const params = tool.parameters.parse({ entry: 100, atr: 10, side: "long" })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ stopLoss: 85, takeProfit: 130 })
  })

  it("short: SL above entry, TP below entry", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_sltp")
    const params = tool.parameters.parse({ entry: 100, atr: 10, side: "short" })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ stopLoss: 115, takeProfit: 70 })
  })

  it("custom multipliers override defaults", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_sltp")
    const params = tool.parameters.parse({ entry: 100, atr: 10, side: "long", slMultiplier: 2, tpMultiplier: 4 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ stopLoss: 80, takeProfit: 140 })
  })

  it("rejects invalid side at parse time", () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_sltp")
    expect(() => tool.parameters.parse({ entry: 100, atr: 10, side: "sideways" })).toThrow()
  })
})

describe("compute_position_size", () => {
  it("computes USDC and contract sizes for 1% risk on 10k equity", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "compute_position_size")
    const params = tool.parameters.parse({ equity: 10000, entry: 100, stopLoss: 95, riskPercent: 1 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ positionSizeUsdc: 2000, positionSizeContracts: 20 })
  })

  it("falls back to ctx.equity when params omit equity", async () => {
    const [tool] = buildRiskEngineTools({ ...CTX, equity: 20000 }).filter((t) => t.name === "compute_position_size")
    const params = tool.parameters.parse({ entry: 100, stopLoss: 95, riskPercent: 1 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ positionSizeUsdc: 4000, positionSizeContracts: 40 })
  })

  it("returns success:false when no equity available", async () => {
    const [tool] = buildRiskEngineTools({ asset: "ETH" }).filter((t) => t.name === "compute_position_size")
    const params = tool.parameters.parse({ entry: 100, stopLoss: 95, riskPercent: 1 })
    const result = await tool.execute(params)

    expect(result.success).toBe(false)
    expect(result.error).toContain("equity")
  })
})

describe("cap_leverage", () => {
  it("caps when llm suggested exceeds max allowed", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "cap_leverage")
    const params = tool.parameters.parse({ llmSuggested: 15, maxAllowed: 10 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ leverage: 10 })
  })

  it("keeps llm value within max allowed and rounds to 1 decimal", async () => {
    const [tool] = buildRiskEngineTools(CTX).filter((t) => t.name === "cap_leverage")
    const params = tool.parameters.parse({ llmSuggested: 3.3333, maxAllowed: 10 })
    const result = await tool.execute(params)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ leverage: 3.3 })
  })
})

describe("buildRiskEngineTools", () => {
  it("returns 4 tools with metadata and described params", () => {
    const tools = buildRiskEngineTools(CTX)
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cap_leverage",
      "compute_atr",
      "compute_position_size",
      "compute_sltp",
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(typeof tool.execute).toBe("function")
      const shape = (tool.parameters as z.ZodObject<Record<string, z.ZodTypeAny>>).shape
      for (const field of Object.values(shape)) {
        expect(field.description).toBeDefined()
      }
    }
  })
})
