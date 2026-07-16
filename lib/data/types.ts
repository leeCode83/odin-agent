export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OnchainData {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  premium: number | null;
  dayVolume: number;
  oiCapReached: boolean;
}

export interface SentimentData {
  fearGreedIndex: number | null;
  fearGreedClassification: string | null;
  trendingRank: number | null;
}

export interface FundamentalData {
  marketCap: number | null;
  totalVolume24h: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  athPrice: number | null;
  athChangePercent: number | null;
  description: string | null;
}

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
