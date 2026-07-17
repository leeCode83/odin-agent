/**
 * @type Factor
 * @description The four pillars of analysis: technical, onchain, sentiment, and fundamental.
 */
type Factor = "technical" | "onchain" | "sentiment" | "fundamental"

/**
 * @interface CategoryConfig
 * @description Configuration defining which analysis factors are active for a specific asset category.
 */
export interface CategoryConfig {
  name: string
  activeFactors: Factor[]
}

const ALL_FACTORS: Factor[] = ["technical", "onchain", "sentiment", "fundamental"]
const MEME_FACTORS: Factor[] = ["technical", "onchain", "sentiment"]

const CATEGORY_MAP: Record<string, CategoryConfig> = {
  major: { name: "major", activeFactors: ALL_FACTORS },
  layer1: { name: "layer1", activeFactors: ALL_FACTORS },
  defi: { name: "defi", activeFactors: ALL_FACTORS },
  meme: { name: "meme", activeFactors: MEME_FACTORS },
}

const ASSET_CATEGORIES: Record<string, string> = {
  BTC: "major",
  ETH: "major",
  SOL: "layer1",
  SUI: "layer1",
  AVAX: "layer1",
  UNI: "defi",
  AAVE: "defi",
  LINK: "defi",
  DOGE: "meme",
  PEPE: "meme",
  WIF: "meme",
}

const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  SUI: "sui",
  AVAX: "avalanche-2",
  UNI: "uniswap",
  AAVE: "aave",
  LINK: "chainlink",
  DOGE: "dogecoin",
  PEPE: "pepe",
  WIF: "dogwifcoin",
}

const COINLORE_ID: Record<string, string> = {
  BTC: "90", ETH: "80", SOL: "485", SUI: "2908", AVAX: "2836",
  UNI: "4567", AAVE: "3374", LINK: "5033", DOGE: "2", PEPE: "5200", WIF: "5230",
}

/**
 * @function getCategory
 * @description Retrieves the full category configuration (active factors) for a given asset.
 * @param {string} asset - The asset ticker (e.g., "BTC", "DOGE").
 * @returns {CategoryConfig | null} The category configuration or null if not found.
 */
export function getCategory(asset: string): CategoryConfig | null {
  const ticker = asset.toUpperCase()
  const categoryName = ASSET_CATEGORIES[ticker] ?? "major"
  return CATEGORY_MAP[categoryName] ?? null
}

/**
 * @function getCategoryName
 * @description Gets the category name string for a given asset. Defaults to "major".
 * @param {string} asset - The asset ticker.
 * @returns {string} The name of the category (e.g., "major", "meme", "layer1").
 */
export function getCategoryName(asset: string): string {
  const ticker = asset.toUpperCase()
  return ASSET_CATEGORIES[ticker] ?? "major"
}

/**
 * @function getCoinGeckoId
 * @description Looks up the CoinGecko API ID for a given asset ticker.
 * @param {string} asset - The asset ticker.
 * @returns {string | null} The CoinGecko ID or null if not mapped.
 */
export function getCoinGeckoId(asset: string): string | null {
  const ticker = asset.toUpperCase()
  return COINGECKO_ID[ticker] ?? null
}

/**
 * @function getCoinLoreId
 * @description Looks up the CoinLore API ID for a given asset ticker.
 * @param {string} asset - The asset ticker.
 * @returns {string | null} The CoinLore ID or null if not mapped.
 */
export function getCoinLoreId(asset: string): string | null {
  const ticker = asset.toUpperCase()
  return COINLORE_ID[ticker] ?? null
}
