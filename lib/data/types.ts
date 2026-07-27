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

