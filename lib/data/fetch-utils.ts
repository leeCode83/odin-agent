import type { CandleData, OnchainData } from "./types"

export interface FearGreedData {
  value: number | null
  classification: string | null
}

export async function fetchWithFallback<T>(
  primary: () => Promise<T | null>,
  fallback: () => Promise<T | null>,
  isValid?: (data: unknown) => data is T
): Promise<T | null> {
  const primaryResult = await primary().catch(() => null)
  if (primaryResult !== null && (!isValid || isValid(primaryResult))) return primaryResult
  const fallbackResult = await fallback().catch(() => null)
  if (fallbackResult !== null && (!isValid || isValid(fallbackResult))) return fallbackResult
  return null
}

export function isValidTechnical(data: unknown): data is {
  candles1h: CandleData[]
  candles15m: CandleData[]
  candles1d: CandleData[]
  currentPrice: number
  priceChange24h: number
} {
  if (typeof data !== "object" || data === null) return false
  const d = data as Record<string, unknown>
  return Array.isArray(d.candles1h) && Array.isArray(d.candles15m) && Array.isArray(d.candles1d)
    && typeof d.currentPrice === "number" && typeof d.priceChange24h === "number"
}

export function isValidOnchain(data: unknown): data is OnchainData {
  if (typeof data !== "object" || data === null) return false
  const d = data as Record<string, unknown>
  return typeof d.fundingRate === "number" && typeof d.openInterest === "number"
    && typeof d.markPrice === "number" && typeof d.oraclePrice === "number"
    && typeof d.dayVolume === "number" && typeof d.oiCapReached === "boolean"
}

export function isValidSentiment(data: unknown): data is FearGreedData {
  if (typeof data !== "object" || data === null) return false
  return true
}

export function isValidFundamental(data: unknown): data is FearGreedData {
  if (typeof data !== "object" || data === null) return false
  return true
}
