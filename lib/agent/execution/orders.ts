import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils"
import type { TradePlan } from "@/lib/agent/types"

interface HLOrderWire {
  a: number
  b: boolean
  p: string
  s: string
  r: boolean
  t: { limit: { tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } }
  c?: `0x${string}`
}

interface BuildOrdersResult {
  entry: HLOrderWire
  takeProfit: HLOrderWire
  stopLoss: HLOrderWire
}

export function buildOrders(tradePlan: TradePlan, assetIndex: number, szDecimals: number): BuildOrdersResult {
  const isLong = tradePlan.side === "long"

  const entry: HLOrderWire = {
    a: assetIndex,
    b: isLong,
    p: formatPrice(tradePlan.entry_price, szDecimals),
    s: formatSize(tradePlan.position_size_contracts, szDecimals),
    r: false,
    t: { limit: { tif: "Gtc" } },
  }

  const takeProfit: HLOrderWire = {
    a: assetIndex,
    b: !isLong,
    p: formatPrice(tradePlan.take_profit, szDecimals),
    s: formatSize(tradePlan.position_size_contracts, szDecimals),
    r: true,
    t: { trigger: { isMarket: false, triggerPx: formatPrice(tradePlan.take_profit, szDecimals), tpsl: "tp" } },
  }

  const stopLoss: HLOrderWire = {
    a: assetIndex,
    b: !isLong,
    p: formatPrice(tradePlan.stop_loss, szDecimals),
    s: formatSize(tradePlan.position_size_contracts, szDecimals),
    r: true,
    t: { trigger: { isMarket: false, triggerPx: formatPrice(tradePlan.stop_loss, szDecimals), tpsl: "sl" } },
  }

  return { entry, takeProfit, stopLoss }
}
