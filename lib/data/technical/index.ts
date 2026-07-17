import type { CandleData } from "@/lib/data/types"
import { fetchCoinLorePrice } from "./coinlore"
import { fetchCoinGeckoOHLC } from "./coingecko"

export interface TechnicalOutput {
  candles1h: CandleData[]
  candles15m: CandleData[]
  candles1d: CandleData[]
  currentPrice: number
  priceChange24h: number
}

export async function fetchTechnicalData(
  asset: string,
  hlTechnical: TechnicalOutput | null
): Promise<TechnicalOutput | null> {
  // 1. Primary: Hyperliquid candles (best granularity: 1h, 15m, 1d)
  if (hlTechnical && hlTechnical.candles1h.length > 0) return hlTechnical
  console.log(`[Technical] HL candles unavailable for ${asset}, trying CoinGecko OHLC`)

  // 2. Fallback: CoinGecko OHLC (actual candle data w/o volume)
  const cgCandles = await fetchCoinGeckoOHLC(asset)
  if (cgCandles) return cgCandles
  console.log(`[Technical] CoinGecko OHLC unavailable for ${asset}, trying CoinLore`)

  // 3. Last resort: CoinLore (price + 24h change only, no candles)
  const coinLore = await fetchCoinLorePrice(asset)
  if (coinLore) {
    console.log(`[Technical] Using CoinLore price data for ${asset}`)
    return {
      candles1h: [], candles15m: [], candles1d: [],
      currentPrice: coinLore.priceUsd,
      priceChange24h: coinLore.change24h,
    }
  }

  console.log(`[Technical] All sources failed for ${asset}`)
  return null
}
