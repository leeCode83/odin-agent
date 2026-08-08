/**
 * @file __tests__/lib/agent/shared/hl-universe.test.ts
 * @description Unit tests for assertAssetInUniverse: in-universe pass
 *   (case-insensitive), unknown asset → HyperliquidUniverseError
 *   ("asset_not_found"), HL network failure → HyperliquidUniverseError
 *   ("unreachable").
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { HyperliquidUniverseError, assertAssetInUniverse } from "@/lib/agent/shared/hl-universe"

const { mockCreateHLClient } = vi.hoisted(() => ({
  mockCreateHLClient: vi.fn(),
}))

vi.mock("@/lib/data/hyperliquid", () => ({
  createHLClient: mockCreateHLClient,
}))

// reason: keep the 15s real timeout out of unit tests — identity passthrough
// preserves the original promise rejection behaviour.
vi.mock("@/lib/utils", () => ({
  withTimeout: (input: unknown) => input,
}))

function makeClient(metaAndAssetCtxs: ReturnType<typeof vi.fn>) {
  return { metaAndAssetCtxs } as never
}

describe("assertAssetInUniverse", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateHLClient.mockReturnValue(
      makeClient(vi.fn().mockResolvedValue([{ universe: [{ name: "BTC" }, { name: "ETH" }] }, []]))
    )
  })

  it("resolves when the asset exists in the universe", async () => {
    await expect(assertAssetInUniverse("BTC")).resolves.toBeUndefined()
    expect(mockCreateHLClient).toHaveBeenCalledTimes(1)
  })

  it("matches asset names case-insensitively", async () => {
    await expect(assertAssetInUniverse("btc")).resolves.toBeUndefined()
    await expect(assertAssetInUniverse("eTh")).resolves.toBeUndefined()
  })

  it("throws asset_not_found for an unknown asset", async () => {
    await expect(assertAssetInUniverse("DOGE")).rejects.toMatchObject({
      kind: "asset_not_found",
      message: expect.stringContaining("DOGE"),
    })
  })

  it("throws asset_not_found as a HyperliquidUniverseError instance", async () => {
    try {
      await assertAssetInUniverse("NOPE")
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HyperliquidUniverseError)
      expect((e as HyperliquidUniverseError).kind).toBe("asset_not_found")
      expect((e as Error).name).toBe("HyperliquidUniverseError")
    }
  })

  it("throws unreachable when the HL API call fails", async () => {
    mockCreateHLClient.mockReturnValue(
      makeClient(vi.fn().mockRejectedValue(new Error("ECONNRESET")))
    )

    try {
      await assertAssetInUniverse("BTC")
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(HyperliquidUniverseError)
      expect((e as HyperliquidUniverseError).kind).toBe("unreachable")
      expect((e as Error).message).toContain("ECONNRESET")
    }
  })
})
