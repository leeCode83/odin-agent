import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { computeLeverage, computePositionSize, computeSLTP } from "@/lib/agent/shared/risk-engine"
import type { TradePlan } from "@/lib/agent/types"

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

vi.mock("@/lib/agent/paper-trading/service", () => ({
  startMonitoring: vi.fn(),
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

vi.mock("@/lib/agent/shared/logger", () => ({
  createLogger: vi.fn(() => vi.fn()),
}))

vi.mock("@/lib/agent/shared/hl-universe", () => ({
  assertAssetInUniverse: vi.fn(),
  HyperliquidUniverseError: class HyperliquidUniverseError extends Error {},
}))

import { POST } from "@/app/api/agent/paper-trading/route"
import { getDb } from "@/lib/db/arango-client"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { readRecentDDReport } from "@/lib/db/graph-memory"
import { startMonitoring } from "@/lib/agent/paper-trading/service"

const save = vi.fn()

function mockDb() {
  save.mockReset()
  save.mockResolvedValue({ _key: "paper-1" })
  vi.mocked(getDb).mockReturnValue({
    collection: vi.fn().mockReturnValue({ save }),
  } as never)
}

function makePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    asset: "BTC",
    side: "long",
    action: "LONG",
    entry_price: 100,
    position_size_usdc: 100,
    position_size_contracts: 1,
    stop_loss: 97,
    take_profit: 106,
    leverage: 3,
    confidence_score: 70,
    confidence_breakdown: { factor_alignment: 70, historical_match: 60, signal_strength: 80 },
    thesis: "t",
    reasoning: "r",
    autonomy_decision: "auto",
    risk_flags: [],
    graph_patterns_used: [],
    timestamp: "2026-07-20T10:00:00Z",
    ...overrides,
  }
}

function postPaperTrade(body: Record<string, unknown>) {
  return POST(new NextRequest("http://localhost/api/agent/paper-trading", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

describe("paper trading risk alignment", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb()
  })

  it("persists exactly the shared risk-engine leverage and position size from the plan", async () => {
    const entry = 100
    const atr = 2
    const leverage = computeLeverage({ entry, atr, confidence: 0.7, maxLeverage: 10 })
    const sltp = computeSLTP(entry, atr, "long")
    const size = computePositionSize(1000, entry, sltp.stopLoss, 10)
    expect(leverage).toBeGreaterThan(0)
    expect(size.positionSizeUsdc).toBeGreaterThan(0)

    const planReport: TradePlan = {
      ...makePlan(),
      entry_price: entry,
      stop_loss: sltp.stopLoss,
      take_profit: sltp.takeProfit,
      leverage,
      position_size_usdc: size.positionSizeUsdc,
      position_size_contracts: size.positionSizeContracts,
    }

    const res = await postPaperTrade({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
      duration: "24h",
      planReport,
    })

    expect(res.status).toBe(201)
    const stored = save.mock.calls[0][0] as Record<string, unknown>
    expect(stored.leverage).toBe(leverage)
    expect(stored.positionSizeUsdc).toBe(size.positionSizeUsdc)
    expect(stored.entryPrice).toBe(entry)
    expect(stored.stopLoss).toBe(sltp.stopLoss)
    expect(stored.takeProfit).toBe(sltp.takeProfit)
  })

  it("persists the NO_TRADE sentinel (leverage 1, size 0) instead of any plan leverage", async () => {
    const noTradePlan: TradePlan = {
      ...makePlan({ leverage: 1, position_size_usdc: 0, entry_price: 0, stop_loss: 0, take_profit: 0 }),
      action: "NO_TRADE",
      side: "long",
    }
    vi.mocked(readRecentDDReport).mockResolvedValue(null)
    vi.mocked(runPlanningPipeline).mockResolvedValue({
      report: noTradePlan,
      ddReport: undefined,
      timing: { ddMs: 0, planningMs: 0, executionMs: 0, totalMs: 0 },
    } as never)

    const res = await postPaperTrade({
      asset: "BTC",
      userId: "user-1",
      walletAddress: "0xmaster",
      duration: "24h",
    })

    expect(res.status).toBe(200)
    const stored = save.mock.calls[0][0] as Record<string, unknown>
    expect(stored.status).toBe("no_trade")
    expect(stored.leverage).toBe(1)
    expect(stored.positionSizeUsdc).toBe(0)
    expect(startMonitoring).not.toHaveBeenCalled()
  })
})
