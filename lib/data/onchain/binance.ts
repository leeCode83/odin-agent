/**
 * @file binance.ts
 * @description Binance Futures API fetcher for onchain/perpetuals data fallback.
 * Provides funding rate, mark price, index price, open interest, and volume
 * via Binance public endpoints (no API key required).
 * @module onchain
 * @layer data
 */

import { withTimeout, withRetry } from "@/lib/utils"

const FAPI_BASE = "https://fapi.binance.com/fapi/v1"

interface BinancePremiumIndex {
  symbol: string
  markPrice: string
  indexPrice: string
  estimatedSettlePrice: string
  lastFundingRate: string
  nextFundingTime: number
  time: number
}

interface BinanceOpenInterest {
  symbol: string
  openInterest: string
  time: number
}

interface BinanceTicker24h {
  symbol: string
  lastPrice: string
  quoteVolume: string
  priceChangePercent: string
}

async function apiGet<T>(url: string): Promise<T | null> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(url), 15_000)
      if (!res.ok) return null
      return (await res.json()) as T
    },
    { retries: 2 }
  ).catch(() => null)
}

function toSymbol(asset: string): string {
  const ticker = asset.toUpperCase()
  return `${ticker}USDT`
}

/**
 * @function fetchBinancePremiumIndex
 * @description Fetches mark price, index price, and funding rate from Binance Futures.
 * @param {string} asset - Asset ticker (e.g. "BTC").
 * @returns {Promise<{ fundingRate: number; markPrice: number; oraclePrice: number } | null>}
 */
async function fetchBinancePremiumIndex(asset: string): Promise<{
  fundingRate: number
  markPrice: number
  oraclePrice: number
} | null> {
  const symbol = toSymbol(asset)
  const data = await apiGet<BinancePremiumIndex>(`${FAPI_BASE}/premiumIndex?symbol=${symbol}`)
  if (!data) return null
  return {
    fundingRate: parseFloat(data.lastFundingRate),
    markPrice: parseFloat(data.markPrice),
    oraclePrice: parseFloat(data.indexPrice),
  }
}

/**
 * @function fetchBinanceOpenInterest
 * @description Fetches open interest from Binance Futures.
 * @param {string} asset - Asset ticker.
 * @returns {Promise<number | null>} Open interest value.
 */
async function fetchBinanceOpenInterest(asset: string): Promise<number | null> {
  const symbol = toSymbol(asset)
  const data = await apiGet<BinanceOpenInterest>(`${FAPI_BASE}/openInterest?symbol=${symbol}`)
  if (!data) return null
  return parseFloat(data.openInterest)
}

/**
 * @function fetchBinanceVolume24h
 * @description Fetches 24h quote volume from Binance Futures ticker.
 * @param {string} asset - Asset ticker.
 * @returns {Promise<number | null>} 24h volume in quote currency.
 */
async function fetchBinanceVolume24h(asset: string): Promise<number | null> {
  const symbol = toSymbol(asset)
  const data = await apiGet<BinanceTicker24h>(`${FAPI_BASE}/ticker/24hr?symbol=${symbol}`)
  if (!data) return null
  return parseFloat(data.quoteVolume)
}

/**
 * @function fetchBinanceOnchain
 * @description Combined fallback fetcher for onchain data via Binance Futures.
 * Aggregates premium index, open interest, and 24h volume into an OnchainOutput.
 * @param {string} asset - Asset ticker.
 * @returns {Promise<{ fundingRate: number; openInterest: number; markPrice: number; oraclePrice: number; premium: null; dayVolume: number; oiCapReached: false } | null>}
 */
export async function fetchBinanceOnchain(asset: string): Promise<{
  fundingRate: number
  openInterest: number
  markPrice: number
  oraclePrice: number
  premium: null
  dayVolume: number
  oiCapReached: false
} | null> {
  const [premium, openInterest, volume24h] = await Promise.all([
    fetchBinancePremiumIndex(asset),
    fetchBinanceOpenInterest(asset),
    fetchBinanceVolume24h(asset),
  ])

  if (!premium) return null

  return {
    fundingRate: premium.fundingRate,
    openInterest: openInterest ?? 0,
    markPrice: premium.markPrice,
    oraclePrice: premium.oraclePrice,
    premium: null,
    dayVolume: volume24h ?? 0,
    oiCapReached: false,
  }
}
