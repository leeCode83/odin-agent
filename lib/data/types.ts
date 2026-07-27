/**
 * @interface CandleData
 * @description Represents a single OHLCV candlestick.
 */
export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * @interface OnchainData
 * @description Standardized representation of on-chain and derivative market data.
 */
export interface OnchainData {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  premium: number | null;
  dayVolume: number;
  oiCapReached: boolean;
}

export interface FearGreedData {
  value: number | null
  classification: string | null
}

export interface GlobalMarketData {
  total_market_cap: number | null
  total_volume_24h: number | null
}

export interface AssetMomentumData {
  price_usd: number | null
  percent_change_1h: number | null
  percent_change_24h: number | null
  percent_change_7d: number | null
  volume_24h_usd: number | null
}

