import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  type ToolDefinition,
  type ToolResult,
  type ToolRegistry,
} from "@/lib/agent/tools/types"
import {
  getToolRegistry,
  getCrossFactorRegistry,
  registerTools,
} from "@/lib/agent/tools/registry"

describe("ToolDefinition interface", () => {
  it("creates a valid tool definition", () => {
    const tool: ToolDefinition = {
      name: "get_price",
      description: "Get current price of an asset",
      parameters: z.object({ asset: z.string() }),
      execute: async () => ({
        success: true,
        data: { price: 65000 },
        metadata: { source: "hyperliquid", latencyMs: 100 },
      }),
    }
    expect(tool.name).toBe("get_price")
    expect(tool.description).toBe("Get current price of an asset")
    expect(tool.parameters).toBeDefined()
  })
})

describe("ToolResult shape", () => {
  it("has correct structure for success", () => {
    const result: ToolResult = {
      success: true,
      data: { price: 65000 },
      metadata: { source: "hyperliquid", latencyMs: 100 },
    }
    expect(result.success).toBe(true)
    expect(result.metadata.source).toBe("hyperliquid")
    expect(result.metadata.latencyMs).toBe(100)
  })

  it("has correct structure for error", () => {
    const result: ToolResult = {
      success: false,
      error: "Something went wrong",
      metadata: { source: "test", latencyMs: 50 },
    }
    expect(result.success).toBe(false)
    expect(result.error).toBe("Something went wrong")
  })
})

describe("ToolRegistry type", () => {
  it("can hold multiple tools by name", () => {
    const registry: ToolRegistry = {}
    expect(registry).toEqual({})
  })
})

describe("getToolRegistry", () => {
  it("throws for unknown factor", () => {
    expect(() => getToolRegistry("unknown")).toThrow()
    expect(() => getToolRegistry("nonexistent")).toThrow()
  })

  it("returns populated registries for non-technical factors", () => {
    const factors = ["onchain", "sentiment", "fundamental"]
    for (const factor of factors) {
      const registry = getToolRegistry(factor)
      expect(Object.keys(registry).length).toBeGreaterThan(0)
    }
  })

  it("returns empty registry for technical factor without candleMap context", () => {
    const registry = getToolRegistry("technical")
    expect(registry).toEqual({})
  })

  it("returns populated registry for technical factor with candleMap context", () => {
    const candleMap = { "1h": [], "15m": [], "1d": [] }
    const registry = getToolRegistry("technical", { candleMap })
    expect(Object.keys(registry).length).toBeGreaterThan(0)
    expect(registry["get_rsi"]).toBeDefined()
  })
})

describe("registerTools", () => {
  it("adds tools to the registry", () => {
    const registry: ToolRegistry = {}
    const tools: ToolDefinition[] = [
      {
        name: "get_price",
        description: "Get current price",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
      {
        name: "get_volume",
        description: "Get volume data",
        parameters: z.object({}),
        execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
      },
    ]
    registerTools(registry, tools)
    expect(registry["get_price"]).toBeDefined()
    expect(registry["get_volume"]).toBeDefined()
    expect(Object.keys(registry)).toHaveLength(2)
  })

  it("overwrites existing tool with same name", () => {
    const registry: ToolRegistry = {}
    const tool1: ToolDefinition = {
      name: "get_price",
      description: "Old version",
      parameters: z.object({}),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    }
    const tool2: ToolDefinition = {
      name: "get_price",
      description: "New version",
      parameters: z.object({}),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    }
    registerTools(registry, [tool1])
    registerTools(registry, [tool2])
    expect(registry["get_price"].description).toBe("New version")
    expect(Object.keys(registry)).toHaveLength(1)
  })
})

describe("getCrossFactorRegistry", () => {
  it("returns empty registry initially", () => {
    const registry = getCrossFactorRegistry()
    expect(registry).toEqual({})
  })
})
