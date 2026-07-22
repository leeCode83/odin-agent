/**
 * @file coin.test.ts
 * @description Tests for POST /api/agent/execution/close/{coin} — close-by-coin endpoint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/execution/close/[coin]/route"

const { mockClosePositionForCoin, mockMetaAndAssetCtxs } = vi.hoisted(() => ({
  mockClosePositionForCoin: vi.fn(),
  mockMetaAndAssetCtxs: vi.fn().mockResolvedValue([{ universe: [{ name: "BTC" }, { name: "ETH" }] }]),
}))

vi.mock("@/lib/agent/execution/close", () => ({
  closePositionForCoin: mockClosePositionForCoin,
}))

vi.mock("@nktkas/hyperliquid", () => {
  class MockInfoClient {
    metaAndAssetCtxs = mockMetaAndAssetCtxs
  }
  return {
    InfoClient: MockInfoClient,
    HttpTransport: class MockHttpTransport {},
  }
})

const OLD_ENV = process.env

function createRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/execution/close/BTC", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env = {
    ...OLD_ENV,
    AGENT_PRIVATE_KEY: "0xkey",
    AGENT_WALLET_ADDRESS: "0xaddr",
  }
  mockClosePositionForCoin.mockResolvedValue({
    closed: 1,
    positions: [{ coin: "BTC", side: "long", size: "0.1", closed: true, oid: 100 }],
  })
})

describe("POST /api/agent/execution/close/[coin]", () => {
  it("returns 200 with close result for valid coin", async () => {
    const res = await POST(createRequest(), { params: Promise.resolve({ coin: "BTC" }) })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.closed).toBe(1)
    expect(data.positions[0].coin).toBe("BTC")
  })

  it("forwards walletAddress from body", async () => {
    await POST(createRequest({ walletAddress: "0xuser" }), { params: Promise.resolve({ coin: "BTC" }) })

    expect(mockClosePositionForCoin).toHaveBeenCalledWith(
      "BTC", "0xkey", "0xaddr", "0xuser"
    )
  })

  it("returns 200 with closed:0 when coin has no position", async () => {
    mockClosePositionForCoin.mockResolvedValue({ closed: 0, positions: [] })

    const res = await POST(createRequest(), { params: Promise.resolve({ coin: "ETH" }) })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.closed).toBe(0)
  })

  it("returns 404 when coin not in Hyperliquid universe", async () => {
    const res = await POST(createRequest(), { params: Promise.resolve({ coin: "INVALID" }) })
    const data = await res.json()

    expect(res.status).toBe(404)
    expect(data.error).toContain("not found")
  })

  it("returns 503 when agent PK not set", async () => {
    process.env.AGENT_PRIVATE_KEY = ""

    const res = await POST(createRequest(), { params: Promise.resolve({ coin: "BTC" }) })
    const data = await res.json()

    expect(res.status).toBe(503)
    expect(data.error).toBe("Agent wallet not initialized")
  })

  it("returns 502 when HL exchange error", async () => {
    mockClosePositionForCoin.mockRejectedValue(new Error("HL timeout"))

    const res = await POST(createRequest(), { params: Promise.resolve({ coin: "BTC" }) })
    const data = await res.json()

    expect(res.status).toBe(502)
    expect(data.error).toBe("HL exchange error")
  })
})
