import type { CandleData, OnchainData } from "./types"

/**
 * @interface FearGreedData
 * @description Standardized format for Fear & Greed index data.
 */
export interface FearGreedData {
  value: number | null
  classification: string | null
}

/**
 * @function fetchWithFallback
 * @description Executes a primary fetcher, and if it fails or returns invalid data, executes a fallback fetcher.
 * @param {() => Promise<T | null>} primary - The primary fetch function.
 * @param {() => Promise<T | null>} fallback - The fallback fetch function.
 * @param {(data: unknown) => data is T} [isValid] - Optional validation function to check the result.
 * @returns {Promise<T | null>} The valid data from either primary or fallback, or null if both fail.
 * @template T
 */
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

/**
 * @function isValidTechnical
 * @description Validates if the provided data conforms to the TechnicalOutput structure.
 * @param {unknown} data - The data to validate.
 * @returns {boolean} True if data is valid technical data, false otherwise.
 */
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

/**
 * @function isValidOnchain
 * @description Validates if the provided data conforms to the OnchainData structure.
 * @param {unknown} data - The data to validate.
 * @returns {boolean} True if data is valid onchain data, false otherwise.
 */
export function isValidOnchain(data: unknown): data is OnchainData {
  if (typeof data !== "object" || data === null) return false
  const d = data as Record<string, unknown>
  return typeof d.fundingRate === "number" && typeof d.openInterest === "number"
    && typeof d.markPrice === "number" && typeof d.oraclePrice === "number"
    && typeof d.dayVolume === "number" && typeof d.oiCapReached === "boolean"
}

/**
 * @function isValidSentiment
 * @description Validates if the provided data conforms to the FearGreedData structure (basic check).
 * @param {unknown} data - The data to validate.
 * @returns {boolean} True if data is an object.
 */
export function isValidSentiment(data: unknown): data is FearGreedData {
  if (typeof data !== "object" || data === null) return false
  return true
}

/**
 * @function isValidFundamental
 * @description Validates if the provided data is a valid fundamental data object (basic check).
 * @param {unknown} data - The data to validate.
 * @returns {boolean} True if data is an object.
 */
export function isValidFundamental(data: unknown): data is FearGreedData {
  if (typeof data !== "object" || data === null) return false
  return true
}
