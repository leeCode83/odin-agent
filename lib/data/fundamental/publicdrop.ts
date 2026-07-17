/**
 * @constant BASE
 * @description Base URL for PublicDrop API.
 */
const BASE = process.env.PUBLICDROP_BASE_URL || "https://api.publicdrop.org/v1"

/**
 * @interface PublicDropData
 * @description Represents the market data retrieved from PublicDrop.
 */
export interface PublicDropData {
  marketCap: number | null
  volume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
}

/**
 * @function fetchPublicDropData
 * @description Fetches market data for a specific asset from PublicDrop.
 * @param {string} asset - The ticker symbol or name of the asset.
 * @returns {Promise<PublicDropData | null>} The retrieved market data or null on failure.
 */
export async function fetchPublicDropData(asset: string): Promise<PublicDropData | null> {
  try {
    const res = await fetch(`${BASE}/assets/${asset.toLowerCase()}`)
    if (!res.ok) return null
    const data = await res.json()
    return {
      marketCap: data?.market_cap ?? null,
      volume24h: data?.volume_24h ?? null,
      circulatingSupply: data?.circulating_supply ?? null,
      totalSupply: data?.total_supply ?? null,
    }
  } catch {
    return null
  }
}
