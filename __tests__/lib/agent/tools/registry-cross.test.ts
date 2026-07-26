import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { z } from "zod"
import type { ToolRegistry } from "@/lib/agent/tools/types"
import {
  getCrossFactorRegistry,
  registerCrossFactorTools,
  resetCrossFactorRegistry,
} from "@/lib/agent/tools/registry"
import {
  getBinanceFundingTool,
  getBinanceOITool,
  getBinanceVolumeTool,
} from "@/lib/data/onchain/binance"

describe("registerCrossFactorTools", () => {
  beforeEach(() => {
    resetCrossFactorRegistry()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("stores tools and getCrossFactorRegistry returns them", () => {
    const registry: ToolRegistry = {
      get_price: {
        name: "get_price",
        description: "Get price",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
      get_volume: {
        name: "get_volume",
        description: "Get volume",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
    }

    expect(getCrossFactorRegistry()).toEqual({})
    registerCrossFactorTools(registry)
    const result = getCrossFactorRegistry()
    expect(result["get_price"]).toBeDefined()
    expect(result["get_volume"]).toBeDefined()
    expect(Object.keys(result)).toHaveLength(2)
  })

  it("accumulates tools across multiple calls", () => {
    const technical: ToolRegistry = {
      tech_indicator: {
        name: "tech_indicator",
        description: "RSI",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "tech", latencyMs: 0 } }),
      },
    }
    const onchain: ToolRegistry = {
      onchain_balance: {
        name: "onchain_balance",
        description: "Balance",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "onchain", latencyMs: 0 } }),
      },
    }

    registerCrossFactorTools(technical)
    registerCrossFactorTools(onchain)
    const result = getCrossFactorRegistry()
    expect(result["tech_indicator"]).toBeDefined()
    expect(result["onchain_balance"]).toBeDefined()
    expect(Object.keys(result)).toHaveLength(2)
  })
})

describe("Binance tool exports", () => {
  it("getBinanceFundingTool is an async function", () => {
    expect(getBinanceFundingTool).toBeInstanceOf(Function)
    expect(getBinanceFundingTool.constructor.name).toBe("AsyncFunction")
  })

  it("getBinanceOITool is an async function", () => {
    expect(getBinanceOITool).toBeInstanceOf(Function)
    expect(getBinanceOITool.constructor.name).toBe("AsyncFunction")
  })

  it("getBinanceVolumeTool is an async function", () => {
    expect(getBinanceVolumeTool).toBeInstanceOf(Function)
    expect(getBinanceVolumeTool.constructor.name).toBe("AsyncFunction")
  })

  it("getBinanceFundingTool returns success: false on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")))
    const result = await getBinanceFundingTool("BTC")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to fetch Binance premium index")
    expect(result.metadata.source).toBe("binance")
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0)
    vi.unstubAllGlobals()
  })

  it("getBinanceFundingTool returns success: false when ok is false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
    const result = await getBinanceFundingTool("BTC")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to fetch Binance premium index")
    vi.unstubAllGlobals()
  })
})
