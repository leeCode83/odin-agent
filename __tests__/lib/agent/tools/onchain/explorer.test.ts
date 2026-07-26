import { describe, it, expect } from "vitest"

let toolsModule: typeof import("@/lib/agent/tools/onchain/explorer") | null = null
async function getModule() {
  if (!toolsModule) {
    toolsModule = await import("@/lib/agent/tools/onchain/explorer")
  }
  return toolsModule
}

describe("get_whale_txns tool", () => {
  it("returns whale transactions for asset", async () => {
    const mod = await getModule()
    const tool = mod.getWhaleTxnsTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.transactions)).toBe(true)
    expect(result.data).toHaveProperty("asset", "BTC")
    expect(result.data.transactions.length).toBeGreaterThan(0)
    if (result.data.transactions.length > 0) {
      expect(result.data.transactions[0]).toHaveProperty("hash")
      expect(result.data.transactions[0]).toHaveProperty("value")
      expect(result.data.transactions[0]).toHaveProperty("from")
      expect(result.data.transactions[0]).toHaveProperty("to")
    }
  })

  it("filters by min value", async () => {
    const mod = await getModule()
    const tool = mod.getWhaleTxnsTool()
    const result = await tool.execute({ asset: "BTC", minValue: 1000000 })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.transactions)).toBe(true)
  })

  it("validates params", async () => {
    const mod = await getModule()
    const tool = mod.getWhaleTxnsTool()
    expect(() => tool.parameters.parse({})).toThrow()
    expect(() => tool.parameters.parse({ asset: "BTC" })).not.toThrow()
  })
})

describe("get_exchange_flow tool", () => {
  it("returns exchange flow data for asset", async () => {
    const mod = await getModule()
    const tool = mod.getExchangeFlowTool()
    const result = await tool.execute({ asset: "BTC" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("asset", "BTC")
    expect(result.data).toHaveProperty("inflow")
    expect(result.data).toHaveProperty("outflow")
    expect(result.data).toHaveProperty("netflow")
    expect(typeof result.data.inflow).toBe("number")
    expect(typeof result.data.outflow).toBe("number")
    expect(typeof result.data.netflow).toBe("number")
  })
})
