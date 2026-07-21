/**
 * @file route.test.ts
 * @description Tests for GET /api/agent/balance endpoint.
 * @module Tests
 * @layer controller
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/api/agent/balance/route"

const { mockFetchUserBalance } = vi.hoisted(() => ({
  mockFetchUserBalance: vi.fn(),
}))

vi.mock("@/lib/data/hyperliquid", () => ({
  fetchUserBalance: mockFetchUserBalance,
}))

function createRequest(walletAddress?: string): NextRequest {
  const url = walletAddress
    ? `http://localhost:3000/api/agent/balance?walletAddress=${encodeURIComponent(walletAddress)}`
    : "http://localhost:3000/api/agent/balance"
  return new NextRequest(url, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/agent/balance", () => {
  it("returns 200 with full balance object for valid walletAddress", async () => {
    mockFetchUserBalance.mockResolvedValue({
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      withdrawable: 450,
      accountValue: 1009,
      totalMarginUsed: 559,
      openPositions: 1,
      crossMaintenanceMarginUsed: 120,
    })

    const res = await GET(createRequest("0x1234567890abcdef1234567890abcdef12345678"))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678")
    expect(data.withdrawable).toBe(450)
    expect(data.accountValue).toBe(1009)
    expect(data.totalMarginUsed).toBe(559)
    expect(data.openPositions).toBe(1)
    expect(data.crossMaintenanceMarginUsed).toBe(120)
  })

  it("returns 400 when walletAddress is missing", async () => {
    const res = await GET(createRequest())
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toBe("walletAddress query parameter required")
  })

  it("returns 400 when walletAddress has invalid format", async () => {
    const res = await GET(createRequest("abc"))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain("Invalid walletAddress")
  })

  it("returns 400 when walletAddress is too short", async () => {
    const res = await GET(createRequest("0x123"))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toContain("Invalid walletAddress")
  })

  it("returns 500 when fetchUserBalance throws", async () => {
    mockFetchUserBalance.mockRejectedValue(new Error("API timeout"))

    const res = await GET(createRequest("0x1234567890abcdef1234567890abcdef12345678"))
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe("Failed to fetch user balance")
    expect(data.detail).toBeDefined()
  })
})
