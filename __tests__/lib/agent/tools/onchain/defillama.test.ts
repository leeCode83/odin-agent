import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

let toolsModule: typeof import("@/lib/agent/due-diligence/tools/onchain/defillama") | null = null
async function getModule() {
  if (!toolsModule) {
    toolsModule = await import("@/lib/agent/due-diligence/tools/onchain/defillama")
  }
  return toolsModule
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe("get_tvl tool", () => {
  it("fetches protocol TVL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => 1234567890,
    })
    const mod = await getModule()
    const tool = mod.getTvlTool()
    const result = await tool.execute({ protocol: "lido" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("protocol", "lido")
    expect(typeof result.data.tvl).toBe("number")
    expect(mockFetch).toHaveBeenCalledWith("https://api.llama.fi/tvl/lido", expect.any(Object))
  })

  it("fetches chain TVLs when protocol omitted", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ gecko_id: "ethereum", tvl: 50000000000, name: "Ethereum" }],
    })
    const mod = await getModule()
    const tool = mod.getTvlTool()
    const result = await tool.execute({ chain: "ethereum" })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.data.chains)).toBe(true)
  })

  it("returns error on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))
    const mod = await getModule()
    const tool = mod.getTvlTool()
    const result = await tool.execute({ protocol: "lido" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Network error")
  })

  it("allows empty params (no protocol or chain)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ gecko_id: "ethereum", tvl: 50000000000, name: "Ethereum" }],
    })
    const mod = await getModule()
    const tool = mod.getTvlTool()
    expect(() => tool.parameters.parse({})).not.toThrow()
  })
})

describe("get_protocol_volume tool", () => {
  it("fetches 24h volume", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ volume: 1000000, total24h: 50000000 }),
    })
    const mod = await getModule()
    const tool = mod.getProtocolVolumeTool()
    const result = await tool.execute({ protocol: "uniswap" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("protocol", "uniswap")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.llama.fi/overview/fees/uniswap?dataType=dailyVolume",
      expect.any(Object)
    )
  })

  it("returns error on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
    const mod = await getModule()
    const tool = mod.getProtocolVolumeTool()
    const result = await tool.execute({ protocol: "nonexistent" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("404")
  })
})

describe("get_protocol_fees tool", () => {
  it("fetches protocol fees", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ fees: 500000, total24h: 25000000 }),
    })
    const mod = await getModule()
    const tool = mod.getProtocolFeesTool()
    const result = await tool.execute({ protocol: "uniswap" })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("protocol", "uniswap")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.llama.fi/overview/fees/uniswap",
      expect.any(Object)
    )
  })
})
