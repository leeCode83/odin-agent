/**
 * @file close.ts
 * @description Position close logic: close all positions or a specific coin's position
 * on Hyperliquid via reduceOnly IoC orders.
 * @module execution
 * @layer service
 */

import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid"
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils"
import { getAgentSigner, getExchangeClient, getAssetIndex } from "./client"
import { recordOutcome } from "@/lib/db/graph-memory"
import { withRetry, withTimeout } from "@/lib/utils"
import type { CloseAllResult } from "./types"

const HL_TIMEOUT_MS = Number(process.env.EXECUTION_HL_TIMEOUT_MS) || 15_000
const TOLERANCE = 0.01

function createInfoClient(): InfoClient {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false"
  return new InfoClient({ transport: new HttpTransport({ isTestnet }) })
}

function getAgentPk(): string {
  const pk = process.env.AGENT_PRIVATE_KEY
  if (!pk) throw new Error("Agent wallet not initialized. Call POST /api/agent/execution/init first")
  return pk
}

function getQueryAddr(walletAddress?: string): string {
  if (walletAddress) return walletAddress
  const addr = process.env.AGENT_WALLET_ADDRESS
  if (!addr) throw new Error("No wallet address available. Provide walletAddress or set AGENT_WALLET_ADDRESS")
  return addr
}

interface PositionInfo {
  coin: string
  szi: string
}

async function fetchPositions(queryAddr: string): Promise<PositionInfo[]> {
  const info = createInfoClient()
  const state = await withRetry(() =>
    withTimeout(() => info.clearinghouseState({ user: queryAddr as `0x${string}` }), HL_TIMEOUT_MS),
    { retries: 2 }
  ) as { assetPositions?: Array<{ position: { coin: string; szi: string } }> } | null

  if (!state?.assetPositions) return []

  return state.assetPositions
    .map((ap) => ap.position)
    .filter((p) => Math.abs(parseFloat(p.szi)) > 0)
}

async function cancelOrdersForCoin(client: ExchangeClient, info: InfoClient, queryAddr: string, coin: string): Promise<void> {
  try {
    const [meta] = await withRetry(() =>
      withTimeout(info.metaAndAssetCtxs(), HL_TIMEOUT_MS),
      { retries: 1 }
    )

    const coinToAsset = new Map<string, number>()
    meta.universe.forEach((u: { name: string }, i: number) => coinToAsset.set(u.name, i))

    const openOrders = await withRetry(() =>
      withTimeout(info.openOrders({ user: queryAddr as `0x${string}` }), HL_TIMEOUT_MS),
      { retries: 1 }
    ) as Array<{ coin: string; oid: number }>

    const cancels = openOrders
      .filter((o) => o.coin === coin)
      .map((o) => ({ a: coinToAsset.get(o.coin) ?? 0, o: o.oid }))

    if (cancels.length > 0) {
      await withRetry(() =>
        withTimeout(client.cancel({ cancels }), HL_TIMEOUT_MS),
        { retries: 1 }
      )
    }
  } catch (err) {
    console.error(`Cancel orders for ${coin} failed (non-fatal):`, err)
  }
}

async function closeSinglePosition(
  client: ExchangeClient,
  info: InfoClient,
  pos: PositionInfo
): Promise<{ oid?: number; error?: string }> {
  const { coin, szi } = pos
  const isLong = parseFloat(szi) > 0
  const closeSide = !isLong

  try {
    const mids = await withRetry(() =>
      withTimeout(info.allMids(), HL_TIMEOUT_MS),
      { retries: 2 }
    ) as Record<string, string>

    const midStr = mids[coin]
    if (!midStr) return { error: `Mid price not found for ${coin}` }

    const mid = parseFloat(midStr)
    // Reason: aggressive price ensures IoC fills immediately; +1% for buys, -1% for sells
    const aggressivePrice = closeSide ? mid * (1 + TOLERANCE) : mid * (1 - TOLERANCE)

    const { assetIndex, szDecimals } = await getAssetIndex(coin)

    const closeOrder = {
      a: assetIndex,
      b: closeSide,
      p: formatPrice(aggressivePrice, szDecimals),
      s: formatSize(Math.abs(parseFloat(szi)), szDecimals),
      r: true,
      t: { limit: { tif: "Ioc" as const } },
    }

    const result = await withRetry(() =>
      withTimeout(client.order({ orders: [closeOrder], grouping: "na" }), HL_TIMEOUT_MS),
      { retries: 2 }
    ) as { response?: { data?: { statuses?: Array<unknown> } } }

    const statuses = result?.response?.data?.statuses ?? []
    const first = statuses[0]
    let oid: number | undefined
    if (first && typeof first === "object") {
      const obj = first as Record<string, unknown>
      if (obj.resting && typeof obj.resting === "object") oid = (obj.resting as Record<string, unknown>).oid as number
      if (obj.filled && typeof obj.filled === "object") oid = (obj.filled as Record<string, unknown>).oid as number
    }

    return { oid }
  } catch (err) {
    return { error: String(err) }
  }
}

async function recordCloseOutcome(coin: string, exitReason: string): Promise<void> {
  try {
    await recordOutcome(`manual_close_${coin}_${Date.now()}`, {
      result: "cancelled",
      exitReason,
    })
  } catch (err) {
    console.error(`Outcome recording failed for ${coin} (non-fatal):`, err)
  }
}

/**
 * @function closeAllPositions
 * @description Closes all filled positions across all coins. Cancels resting orders first,
 * then places reduceOnly IoC orders at aggressive prices. Records outcomes to graph memory.
 * @param {string} [agentPk] - Agent wallet private key (falls back to AGENT_PRIVATE_KEY env).
 * @param {string} [agentAddr] - Agent wallet address for signing (falls back to AGENT_WALLET_ADDRESS).
 * @param {string} [walletAddress] - Wallet address to query positions for (falls back to agentAddr).
 * @returns {Promise<CloseAllResult>} Summary of closed positions.
 */
export async function closeAllPositions(
  agentPk?: string,
  agentAddr?: string,
  walletAddress?: string
): Promise<CloseAllResult> {
  const pk = agentPk || getAgentPk()
  const account = getAgentSigner(pk)
  const client = getExchangeClient(account)
  const info = createInfoClient()
  const queryAddr = getQueryAddr(walletAddress || agentAddr)

  const positions = await fetchPositions(queryAddr)
  if (positions.length === 0) return { closed: 0, positions: [] }

  const results: CloseAllResult["positions"] = []

  for (const pos of positions) {
    await cancelOrdersForCoin(client, info, queryAddr, pos.coin)
    const { oid, error } = await closeSinglePosition(client, info, pos)
    const isLong = parseFloat(pos.szi) > 0

    results.push({
      coin: pos.coin,
      side: isLong ? "long" : "short",
      size: Math.abs(parseFloat(pos.szi)).toString(),
      closed: !error,
      oid,
      error,
    })

    if (!error) {
      await recordCloseOutcome(pos.coin, "manual_close")
    }
  }

  return {
    closed: results.filter((r) => r.closed).length,
    positions: results,
  }
}

/**
 * @function closePositionForCoin
 * @description Closes all filled positions for a specific coin.
 * @param {string} coin - The coin/asset to close (e.g. "BTC").
 * @param {string} [agentPk] - Agent wallet private key (falls back to AGENT_PRIVATE_KEY env).
 * @param {string} [agentAddr] - Agent wallet address for signing (falls back to AGENT_WALLET_ADDRESS).
 * @param {string} [walletAddress] - Wallet address to query positions for (falls back to agentAddr).
 * @returns {Promise<CloseAllResult>} Summary of closed positions.
 */
export async function closePositionForCoin(
  coin: string,
  agentPk?: string,
  agentAddr?: string,
  walletAddress?: string
): Promise<CloseAllResult> {
  const pk = agentPk || getAgentPk()
  const account = getAgentSigner(pk)
  const client = getExchangeClient(account)
  const info = createInfoClient()
  const queryAddr = getQueryAddr(walletAddress || agentAddr)

  const positions = await fetchPositions(queryAddr)
  const target = positions.find((p) => p.coin === coin)
  if (!target) return { closed: 0, positions: [] }

  await cancelOrdersForCoin(client, info, queryAddr, coin)
  const { oid, error } = await closeSinglePosition(client, info, target)
  const isLong = parseFloat(target.szi) > 0

  const result: CloseAllResult = {
    closed: error ? 0 : 1,
    positions: [{
      coin: target.coin,
      side: isLong ? "long" : "short",
      size: Math.abs(parseFloat(target.szi)).toString(),
      closed: !error,
      oid,
      error,
    }],
  }

  if (!error) {
    await recordCloseOutcome(coin, "manual_close")
  }

  return result
}
