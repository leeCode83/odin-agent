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

/**
 * @interface SentimentData
 * @description Standardized representation of market sentiment data.
 */
export interface SentimentData {
  fearGreedIndex: number | null;
  fearGreedClassification: string | null;
  trendingRank: number | null;
}

/**
 * @interface FundamentalData
 * @description Standardized representation of fundamental asset properties.
 */
export interface FundamentalData {
  marketCap: number | null;
  totalVolume24h: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  athPrice: number | null;
  athChangePercent: number | null;
  description: string | null;
}

/**
 * @interface RawFactorData
 * @description Aggregates all raw factor data streams into a single structured object.
 */
export interface RawFactorData {
  technical: {
    candles1h: CandleData[];
    candles15m: CandleData[];
    candles1d: CandleData[];
    currentPrice: number;
    priceChange24h: number;
  };
  onchain: OnchainData;
  sentiment: SentimentData;
  fundamental: FundamentalData;
}
