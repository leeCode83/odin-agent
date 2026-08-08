/**
 * @file shared/hl-universe.ts
 * @description Hyperliquid universe validation shared across API routes.
 *   Ensures an asset exists in the HL perpetuals universe before the DD
 *   agent runs, so unknown assets fail fast instead of producing empty reports.
 * @module shared/hl-universe
 * @layer service
 */

import type { InfoClient } from "@nktkas/hyperliquid"
import { createHLClient } from "@/lib/data/hyperliquid"
import { withTimeout } from "@/lib/utils"

/**
 * @class HyperliquidUniverseError
 * @description Error thrown by assertAssetInUniverse. `kind` distinguishes
 *   validation outcomes so callers can map to the right HTTP status:
 *   - "asset_not_found": asset is not in the HL universe (client error, 400/404)
 *   - "unreachable": HL itself failed / timed out (server error, 503) — blocks
 *     the request on purpose; if HL is down trading is impossible anyway.
 */
export class HyperliquidUniverseError extends Error {
  constructor(
    readonly kind: "asset_not_found" | "unreachable",
    message: string,
  ) {
    super(message)
    this.name = "HyperliquidUniverseError"
  }
}

/**
 * @function assertAssetInUniverse
 * @description Verifies the asset exists in the Hyperliquid perpetuals universe
 *   via metaAndAssetCtxs() with a 15s timeout (same pattern as other HL calls).
 *   Asset lookup is case-insensitive (HL uses uppercase tickers).
 *   Throws HyperliquidUniverseError on both failure modes:
 *   - asset not found → kind "asset_not_found"
 *   - HL network error / timeout → kind "unreachable" (never falls through)
 * @param {string} asset - Asset ticker (e.g. "BTC").
 * @returns {Promise<void>} Resolves when the asset is in the universe.
 * @throws {HyperliquidUniverseError} When the asset is unknown or HL is unreachable.
 */
export async function assertAssetInUniverse(asset: string): Promise<void> {
  const client = createHLClient()
  let metaAndCtxs: Awaited<ReturnType<InfoClient["metaAndAssetCtxs"]>> | null = null
  try {
    metaAndCtxs = await withTimeout(client.metaAndAssetCtxs(), 15_000)
  } catch (err) {
    throw new HyperliquidUniverseError(
      "unreachable",
      `Hyperliquid unreachable while validating ${asset}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const [meta] = metaAndCtxs
  const ticker = asset.toUpperCase()
  const found = meta.universe.some((u) => u.name.toUpperCase() === ticker)
  if (!found) {
    throw new HyperliquidUniverseError(
      "asset_not_found",
      `Asset ${asset} not found in Hyperliquid universe`,
    )
  }
}
