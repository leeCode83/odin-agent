import type { OnchainData } from "@/lib/data/types"
import { fetchBinanceOnchain } from "./binance"

/**
 * @interface OnchainOutput
 * @description Standardized output for on-chain and derivative data.
 */
export interface OnchainOutput {
  fundingRate: number
  openInterest: number
  markPrice: number
  oraclePrice: number
  premium: number | null
  dayVolume: number
  oiCapReached: boolean
}

/**
 * @function fetchOnchainData
 * @description Orchestrates the fetching of on-chain/derivative data, prioritizing Hyperliquid and falling back to Binance Futures.
 * @param {string} asset - The ticker symbol or asset name.
 * @param {OnchainData | null} hlOnchain - Existing Hyperliquid onchain data, if available.
 * @returns {Promise<OnchainOutput | null>} Standardized on-chain data, or null if all sources fail.
 */
export async function fetchOnchainData(
  asset: string,
  hlOnchain: OnchainData | null
): Promise<OnchainOutput | null> {
  // 1. Primary: Hyperliquid onchain data (most accurate, HL-specific fields)
  if (hlOnchain && hlOnchain.openInterest > 0) {
    return {
      fundingRate: hlOnchain.fundingRate,
      openInterest: hlOnchain.openInterest,
      markPrice: hlOnchain.markPrice,
      oraclePrice: hlOnchain.oraclePrice,
      premium: hlOnchain.premium,
      dayVolume: hlOnchain.dayVolume,
      oiCapReached: hlOnchain.oiCapReached,
    }
  }
  console.log(`[Onchain] HL data unavailable for ${asset}, trying Binance Futures`)

  // 2. Fallback: Binance Futures (market-wide proxy, no HL-specific fields)
  const binance = await fetchBinanceOnchain(asset)
  if (binance) {
    console.log(`[Onchain] Using Binance Futures data for ${asset}`)
    return binance
  }

  console.log(`[Onchain] Binance Futures also failed for ${asset}`)
  return null
}
