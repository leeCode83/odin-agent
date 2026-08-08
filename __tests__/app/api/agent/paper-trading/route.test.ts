import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

vi.mock("@/lib/agent/due-diligence/agent", () => ({
  runDDAgent: vi.fn(),
}))

vi.mock("@/lib/agent/pipeline", () => ({
  runPlanningPipeline: vi.fn(),
}))

vi.mock("@/lib/db/graph-memory", () => ({
  readRecentDDReport: vi.fn(),
}))

vi.mock("@/lib/agent/paper-trading/service", () => ({
  startMonitoring: vi.fn(),
}))

const { mockAssertAssetInUniverse } = vi.hoisted(() => ({
  mockAssertAssetInUniverse: vi.fn(),
}))

vi.mock("@/lib/agent/shared/hl-universe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/shared/hl-universe")>()
  return { ...actual, assertAssetInUniverse: mockAssertAssetInUniverse }
})

import { getDb } from "@/lib/db/arango-client"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { readRecentDDReport } from "@/lib/db/graph-memory"
import { startMonitoring } from "@/lib/agent/paper-trading/service"
import { HyperliquidUniverseError } from "@/lib/agent/shared/hl-universe"

function mockNextRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agent/paper-trading", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  asset: "BTC",
  userId: "user1",
  walletAddress: "0x1234",
  duration: "24h",
}

const MOCK_TRADE_PLAN = {
  asset: "BTC",
  side: "long",
  entry_price: 50000,
  stop_loss: 48000,
  take_profit: 55000,
  leverage: 5,
  position_size_usdc: 100,
}

const MOCK_DD_REPORT = {
  asset: "BTC",
  category: "major",
  status: "complete",
  confidence_score: 80,
  sections: { technical: { score: 80 }, onchain: { score: 75 }, sentiment: { score: 70 }, fundamental: { score: 85 } },
}

function mockDbSuccess() {
  const collection = {
    save: vi.fn().mockResolvedValue({ _key: "paper-1" }),
    document: vi.fn(),
    update: vi.fn(),
  }
  vi.mocked(getDb).mockReturnValue({ collection: vi.fn().mockReturnValue(collection) } as never)
  return collection
}

async function post(body: unknown) {
  const { POST } = await import("@/app/api/agent/paper-trading/route")
  return POST(mockNextRequest(body))
}

describe("POST /api/agent/paper-trading", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbSuccess()
    vi.mocked(readRecentDDReport).mockResolvedValue(null)
    vi.mocked(runDDAgent).mockResolvedValue(MOCK_DD_REPORT as never)
    vi.mocked(runPlanningPipeline).mockResolvedValue({ report: MOCK_TRADE_PLAN } as never)
    mockAssertAssetInUniverse.mockResolvedValue(undefined)
  })

  it("returns 201 with planReport provided (skip DD + Planning)", async () => {
    const res = await post({ ...VALID_BODY, planReport: MOCK_TRADE_PLAN })

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe("paper-1")
    expect(json.status).toBe("active")
    expect(json.asset).toBe("BTC")
    expect(json.side).toBe("long")
    expect(json.entryPrice).toBe(50000)
    expect(json.duration).toBe("24h")
    expect(startMonitoring).toHaveBeenCalledWith("paper-1")
    expect(runDDAgent).not.toHaveBeenCalled()
    expect(runPlanningPipeline).not.toHaveBeenCalled()
  })

  it("returns 201 with full DD → Planning pipeline", async () => {
    const res = await post(VALID_BODY)

    expect(res.status).toBe(201)
    expect(runDDAgent).toHaveBeenCalled()
    expect(runPlanningPipeline).toHaveBeenCalled()
    expect(startMonitoring).toHaveBeenCalled()
  })

  it("returns 201 using cached DD report", async () => {
    vi.mocked(readRecentDDReport).mockResolvedValue(MOCK_DD_REPORT as never)

    const res = await post(VALID_BODY)

    expect(res.status).toBe(201)
    expect(runDDAgent).not.toHaveBeenCalled()
    expect(runPlanningPipeline).toHaveBeenCalled()
  })

  it("returns 400 for missing asset", async () => {
    const res = await post({ userId: "user1", walletAddress: "0x1234", duration: "24h" })

    expect(res.status).toBe(400)
  })

  it("returns 400 for invalid duration", async () => {
    const res = await post({ ...VALID_BODY, duration: "10h" })

    expect(res.status).toBe(400)
  })

  it("returns 400 for invalid JSON", async () => {
    const { POST } = await import("@/app/api/agent/paper-trading/route")
    const req = new NextRequest("http://localhost/api/agent/paper-trading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
  })

  it("returns 503 when DB unavailable", async () => {
    vi.mocked(getDb).mockReturnValue(null)

    const res = await post(VALID_BODY)

    expect(res.status).toBe(503)
  })

  it("returns 422 when DD agent fails", async () => {
    vi.mocked(runDDAgent).mockRejectedValueOnce(new Error("DD crash"))

    const res = await post(VALID_BODY)

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toBe("DD_AGENT_FAILED")
  })

  it("returns 422 when planning fails", async () => {
    vi.mocked(runPlanningPipeline).mockRejectedValueOnce(new Error("Planning crash"))

    const res = await post(VALID_BODY)

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toBe("PLANNING_FAILED")
  })

  it("returns 400 UNKNOWN_ASSET when the asset is not in the HL universe", async () => {
    mockAssertAssetInUniverse.mockRejectedValue(
      new HyperliquidUniverseError("asset_not_found", "Asset DOGE not found in Hyperliquid universe")
    )

    const res = await post({ ...VALID_BODY, asset: "DOGE" })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe("UNKNOWN_ASSET")
    expect(runDDAgent).not.toHaveBeenCalled()
    expect(runPlanningPipeline).not.toHaveBeenCalled()
  })

  it("returns 503 HL_UNAVAILABLE when Hyperliquid is unreachable", async () => {
    mockAssertAssetInUniverse.mockRejectedValue(
      new HyperliquidUniverseError("unreachable", "Hyperliquid unreachable while validating BTC: ECONNRESET")
    )

    const res = await post(VALID_BODY)
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json.error).toBe("HL_UNAVAILABLE")
    expect(runDDAgent).not.toHaveBeenCalled()
    expect(runPlanningPipeline).not.toHaveBeenCalled()
  })
})
