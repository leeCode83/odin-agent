/**
 * @file route.test.ts
 * @description Tests for POST /api/agent/execution/close — close-all endpoint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/execution/close/route"

const { mockCloseAllPositions } = vi.hoisted(() => ({
  mockCloseAllPositions: vi.fn(),
}))

vi.mock("@/lib/agent/execution/close", () => ({
  closeAllPositions: mockCloseAllPositions,
}))

const OLD_ENV = process.env

function createRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/execution/close", {
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
  mockCloseAllPositions.mockResolvedValue({
    closed: 2,
    positions: [
      { coin: "BTC", side: "long", size: "0.1", closed: true, oid: 100 },
      { coin: "ETH", side: "short", size: "2.0", closed: true, oid: 101 },
    ],
  })
})

describe("POST /api/agent/execution/close", () => {
  it("returns 200 with close result", async () => {
    const res = await POST(createRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.closed).toBe(2)
    expect(data.positions).toHaveLength(2)
  })

  it("forwards walletAddress from body to closeAllPositions", async () => {
    await POST(createRequest({ walletAddress: "0xuser" }))

    expect(mockCloseAllPositions).toHaveBeenCalledWith(
      "0xkey", "0xaddr", "0xuser"
    )
  })

  it("returns 200 with closed:0 when no positions", async () => {
    mockCloseAllPositions.mockResolvedValue({ closed: 0, positions: [] })

    const res = await POST(createRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.closed).toBe(0)
  })

  it("returns 503 when agent PK not set", async () => {
    process.env.AGENT_PRIVATE_KEY = ""

    const res = await POST(createRequest())
    const data = await res.json()

    expect(res.status).toBe(503)
    expect(data.error).toBe("Agent wallet not initialized")
  })

  it("returns 502 when HL exchange error", async () => {
    mockCloseAllPositions.mockRejectedValue(new Error("Exchange timeout"))

    const res = await POST(createRequest())
    const data = await res.json()

    expect(res.status).toBe(502)
    expect(data.error).toBe("HL exchange error")
  })
})
