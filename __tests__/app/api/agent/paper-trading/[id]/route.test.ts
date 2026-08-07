import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

vi.mock("@/lib/agent/shared/logger", () => ({
  createLogger: vi.fn(() => vi.fn()),
}))

import { getDb } from "@/lib/db/arango-client"

const MOCK_TRADE = {
  _key: "paper-1",
  asset: "BTC",
  side: "long",
  entryPrice: 50000,
  stopLoss: 48000,
  takeProfit: 55000,
  leverage: 5,
  positionSizeUsdc: 100,
  status: "active",
  duration: "24h",
  startedAt: "2026-08-01T00:00:00.000Z",
  closedAt: null,
  closedPrice: null,
  pnlUsdc: null,
  pnlPercent: null,
  lastCheckedPrice: 50100,
  lastCheckedAt: "2026-08-01T01:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
}

function mockDbWithDoc(doc: Record<string, unknown> | null) {
  const collection = {
    document: vi.fn().mockResolvedValue(doc),
    update: vi.fn(),
    insert: vi.fn(),
  }
  vi.mocked(getDb).mockReturnValue({ collection: vi.fn().mockReturnValue(collection) } as never)
  return collection
}

async function get(id: string) {
  const { GET } = await import("@/app/api/agent/paper-trading/[id]/route")
  const req = new NextRequest(`http://localhost/api/agent/paper-trading/${id}`)
  return GET(req, { params: Promise.resolve({ id }) })
}

describe("GET /api/agent/paper-trading/[id]", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 200 with trade data", async () => {
    mockDbWithDoc(MOCK_TRADE)

    const res = await get("paper-1")

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe("paper-1")
    expect(json.asset).toBe("BTC")
    expect(json.side).toBe("long")
    expect(json.entryPrice).toBe(50000)
    expect(json.status).toBe("active")
    expect(json.duration).toBe("24h")
  })

  it("returns 404 for unknown trade", async () => {
    mockDbWithDoc(null)

    const res = await get("nonexistent")

    expect(res.status).toBe(404)
  })

  it("returns 503 when DB unavailable", async () => {
    vi.mocked(getDb).mockReturnValue(null)

    const res = await get("paper-1")

    expect(res.status).toBe(503)
  })

  it("returns closed trade data with PnL", async () => {
    mockDbWithDoc({ ...MOCK_TRADE, status: "tp_hit", closedPrice: 55000, pnlUsdc: 50, pnlPercent: 5 })

    const res = await get("paper-1")

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("tp_hit")
    expect(json.closedPrice).toBe(55000)
    expect(json.pnlUsdc).toBe(50)
  })
})
