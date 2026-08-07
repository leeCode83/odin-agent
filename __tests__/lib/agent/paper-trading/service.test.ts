import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: vi.fn(),
}))

vi.mock("@/lib/db/arango-client", () => ({
  getDb: vi.fn(),
}))

vi.mock("@/lib/db/graph-memory", () => ({
  recordOutcome: vi.fn(),
}))

vi.mock("@/lib/agent/shared/logger", () => ({
  createLogger: vi.fn(() => vi.fn()),
}))

import { pollPrice, detectCross, closePaperTrade, startMonitoring, stopMonitoring, getActiveMonitorCount } from "@/lib/agent/paper-trading/service"
import { createHLClient } from "@/lib/data/hyperliquid"
import { getDb } from "@/lib/db/arango-client"
import { recordOutcome } from "@/lib/db/graph-memory"

function mockAllMids(prices: Record<string, number>) {
  vi.mocked(createHLClient).mockReturnValue({ allMids: vi.fn().mockResolvedValue(prices) } as never)
}

function mockDbCollection(doc: Record<string, unknown> | null = null) {
  const collection = {
    document: vi.fn().mockResolvedValue(doc),
    update: vi.fn().mockResolvedValue({}),
    insert: vi.fn().mockResolvedValue({ _key: "new-key" }),
  }
  vi.mocked(getDb).mockReturnValue({ collection: vi.fn().mockReturnValue(collection) } as never)
  return collection
}

describe("pollPrice", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns PriceSnapshot for valid asset", async () => {
    mockAllMids({ BTC: 50000 })

    const snapshot = await pollPrice("BTC")

    expect(snapshot).not.toBeNull()
    expect(snapshot!.price).toBe(50000)
    expect(snapshot!.source).toBe("hyperliquid")
    expect(snapshot!.fetchedAt).toBeTruthy()
  })

  it("returns null for unknown asset", async () => {
    mockAllMids({ BTC: 50000 })

    const snapshot = await pollPrice("XYZ")

    expect(snapshot).toBeNull()
  })

  it("returns null on fetch error", async () => {
    vi.mocked(createHLClient).mockReturnValue({ allMids: vi.fn().mockRejectedValue(new Error("network")) } as never)

    const snapshot = await pollPrice("BTC")

    expect(snapshot).toBeNull()
  })
})

describe("detectCross", () => {
  it("detects TP cross for long", () => {
    const result = detectCross(49000, 51000, 50000, 48000, "long")

    expect(result.tpCrossed).toBe(true)
    expect(result.slCrossed).toBe(false)
    expect(result.fillPrice).toBe(50000)
  })

  it("detects SL cross for long", () => {
    const result = detectCross(49000, 47000, 50000, 48000, "long")

    expect(result.tpCrossed).toBe(false)
    expect(result.slCrossed).toBe(true)
    expect(result.fillPrice).toBe(48000)
  })

  it("detects no cross for long (price stayed in range)", () => {
    const result = detectCross(49000, 49500, 50000, 48000, "long")

    expect(result.tpCrossed).toBe(false)
    expect(result.slCrossed).toBe(false)
  })

  it("detects TP cross for short (price goes down)", () => {
    const result = detectCross(51000, 49000, 50000, 52000, "short")

    expect(result.tpCrossed).toBe(true)
    expect(result.slCrossed).toBe(false)
    expect(result.fillPrice).toBe(50000)
  })

  it("detects SL cross for short (price goes up)", () => {
    const result = detectCross(51000, 53000, 50000, 52000, "short")

    expect(result.tpCrossed).toBe(false)
    expect(result.slCrossed).toBe(true)
    expect(result.fillPrice).toBe(52000)
  })

  it("detects no cross for short (price stayed in range)", () => {
    const result = detectCross(51000, 51500, 50000, 52000, "short")

    expect(result.tpCrossed).toBe(false)
    expect(result.slCrossed).toBe(false)
  })

  it("does not cross when price was already beyond threshold", () => {
    const result = detectCross(51000, 52000, 50000, 48000, "long")

    expect(result.tpCrossed).toBe(false)
    expect(result.slCrossed).toBe(false)
  })
})

describe("closePaperTrade", () => {
  beforeEach(() => vi.clearAllMocks())

  it("updates trade and records outcome to graph memory", async () => {
    const trade = {
      _key: "k1",
      side: "long",
      entryPrice: 50000,
      leverage: 5,
      positionSizeUsdc: 100,
    }
    const collection = mockDbCollection(trade)

    await closePaperTrade("k1", "tp_hit", 52000)

    expect(collection.update).toHaveBeenCalledWith("k1", expect.objectContaining({
      status: "tp_hit",
      closedPrice: 52000,
    }))
    expect(recordOutcome).toHaveBeenCalledWith("k1", expect.objectContaining({
      result: "profit",
      exitReason: "tp_hit",
    }))
  })

  it("records loss outcome when price goes against trade", async () => {
    const trade = {
      _key: "k2",
      side: "long",
      entryPrice: 50000,
      leverage: 5,
      positionSizeUsdc: 100,
    }
    mockDbCollection(trade)

    await closePaperTrade("k2", "sl_hit", 48000)

    expect(recordOutcome).toHaveBeenCalledWith("k2", expect.objectContaining({
      result: "loss",
    }))
  })

  it("does nothing if DB unavailable", async () => {
    vi.mocked(getDb).mockReturnValue(null)

    await closePaperTrade("k1", "tp_hit", 52000)

    expect(recordOutcome).not.toHaveBeenCalled()
  })

  it("does nothing if trade not found", async () => {
    mockDbCollection(null)

    await closePaperTrade("k1", "tp_hit", 52000)

    expect(recordOutcome).not.toHaveBeenCalled()
  })
})

describe("startMonitoring / stopMonitoring / getActiveMonitorCount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts a monitor and increments count", () => {
    startMonitoring("k1")

    expect(getActiveMonitorCount()).toBe(1)
  })

  it("does not duplicate monitors for same key", () => {
    startMonitoring("k1")
    startMonitoring("k1")

    expect(getActiveMonitorCount()).toBe(1)
  })

  it("stops a monitor and decrements count", () => {
    startMonitoring("k1")
    stopMonitoring("k1")

    expect(getActiveMonitorCount()).toBe(0)
  })

  it("stopMonitoring is no-op for unknown key", () => {
    stopMonitoring("unknown")
    expect(getActiveMonitorCount()).toBe(0)
  })
})
