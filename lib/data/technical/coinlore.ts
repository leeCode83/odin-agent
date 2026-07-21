/**
 * @constant BASE
 * @description Base URL for CoinLore API.
 */
const BASE = process.env.COINLORE_BASE_URL || "https://api.coinlore.net/api"

/**
 * @constant COINLORE_TICKER
 * @description Mapping of major assets to CoinLore IDs.
 */
const COINLORE_TICKER: Record<string, string> = {
  BTC: "90", ETH: "80", SOL: "485", SUI: "2908", AVAX: "2836",
  UNI: "4567", AAVE: "3374", LINK: "5033", DOGE: "2", PEPE: "5200", WIF: "5230",
}

/**
 * @interface CoinLoreTicker
 * @description Represents ticker data from CoinLore.
 */
interface CoinLoreTicker {
  price_usd: string
  percent_change_24h: string
}

/**
 * @function apiGet
 * @description Helper function to perform GET requests.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<T | null>} The parsed JSON response or null on failure.
 * @template T
 */
async function apiGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch { return null }
}

/**
 * @function fetchCoinLorePrice
 * @description Fetches basic price and 24h change data for a specific asset from CoinLore.
 * @param {string} asset - The ticker symbol.
 * @returns {Promise<{ priceUsd: number; change24h: number } | null>} Price and change data, or null on failure.
 */
export async function fetchCoinLorePrice(asset: string): Promise<{ priceUsd: number; change24h: number } | null> {
  const id = COINLORE_TICKER[asset.toUpperCase()]
  if (!id) return null
  const data = await apiGet<CoinLoreTicker[]>(`${BASE}/ticker/?id=${id}`)
  if (!data || data.length === 0) return null
  return {
    priceUsd: parseFloat(data[0].price_usd),
    change24h: parseFloat(data[0].percent_change_24h),
  }
}
