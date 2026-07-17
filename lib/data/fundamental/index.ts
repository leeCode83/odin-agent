import { fetchMetadata } from "./coingecko-metadata"
import { fetchPublicDropData } from "./publicdrop"

/**
 * @interface FundamentalOutput
 * @description Standardized output for fundamental asset data from various providers.
 */
export interface FundamentalOutput {
  marketCap: number | null
  totalVolume24h: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  athPrice: number | null
  athChangePercent: number | null
  description: string | null
}

/**
 * @function fetchFundamentalData
 * @description Orchestrates the fetching of fundamental data, falling back to PublicDrop if CoinGecko fails.
 * @param {string | null} cgId - The CoinGecko ID for the asset, if available.
 * @param {string} asset - The ticker symbol or standard name of the asset.
 * @returns {Promise<FundamentalOutput | null>} The standardized fundamental data, or null if all sources fail.
 */
export async function fetchFundamentalData(cgId: string | null, asset: string): Promise<FundamentalOutput | null> {
  const cg = cgId ? await fetchMetadata(cgId).catch(() => null) : null
  if (cg) {
    return {
      marketCap: cg.marketCap,
      totalVolume24h: cg.volume24h,
      circulatingSupply: cg.circulatingSupply,
      totalSupply: cg.totalSupply,
      athPrice: cg.ath,
      athChangePercent: cg.athChange,
      description: cg.description,
    }
  }
  console.log(`[Fundamental] CoinGecko metadata unavailable for ${asset}, trying PublicDrop`)

  const pd = await fetchPublicDropData(asset).catch(() => null)
  if (pd) {
    console.log(`[Fundamental] Using PublicDrop data for ${asset}`)
    return {
      marketCap: pd.marketCap,
      totalVolume24h: pd.volume24h,
      circulatingSupply: pd.circulatingSupply,
      totalSupply: pd.totalSupply,
      athPrice: null,
      athChangePercent: null,
      description: null,
    }
  }

  console.log(`[Fundamental] PublicDrop also failed for ${asset}`)
  return null
}
