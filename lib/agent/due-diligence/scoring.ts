/**
 * @file due-diligence/scoring.ts
 * @description Pure deterministic factor scoring. Converts structured tool outputs
 *   (RSI bands, MACD histogram, funding regime, OI divergence, exchange flows, etc.)
 *   into a 0-100 factor score plus typed signals. No IO, no LLM — every formula is a
 *   documented deterministic rule so numeric decisions never depend on model judgment.
 * @module due-diligence
 * @layer service
 */

/**
 * @typedef SignalType
 * @description Direction of a deterministic signal.
 */
export type SignalType = "bullish" | "bearish" | "neutral"

/**
 * @interface Signal
 * @description One deterministic signal extracted from a structured tool output.
 * @property {string} name - Short human-readable signal name.
 * @property {SignalType} type - Direction of the signal.
 * @property {number | string} [value] - The raw value that produced the signal.
 * @property {string} [detail] - Optional explanation of the rule that fired.
 */
export interface Signal {
  name: string
  type: SignalType
  value?: number | string
  detail?: string
}

/**
 * @interface FactorScore
 * @description Deterministic score for one factor, computed from tool data.
 * @property {string} factor - Factor name (technical/sentiment/onchain/fundamental).
 * @property {number} score - 0-100 score (higher = more bullish).
 * @property {Signal[]} signals - Signals that fired, one per evaluated indicator.
 */
export interface FactorScore {
  factor: string
  score: number
  signals: Signal[]
}

// --- Thresholds (documented constants backing the formulas below) ------------

/** @constant {number} RSI_OVERSOLD - RSI below this = oversold (contrarian bullish). */
export const RSI_OVERSOLD = 30
/** @constant {number} RSI_OVERBOUGHT - RSI above this = overbought (bearish). */
export const RSI_OVERBOUGHT = 70
/** @constant {number} STOCH_OVERSOLD - Stochastic %K below this = oversold (bullish). */
export const STOCH_OVERSOLD = 20
/** @constant {number} STOCH_OVERBOUGHT - Stochastic %K above this = overbought (bearish). */
export const STOCH_OVERBOUGHT = 80
/** @constant {number} VOLUME_SPIKE_RATIO - current/avg volume above this = volume spike. */
export const VOLUME_SPIKE_RATIO = 1.5
/** @constant {number} FUNDING_OVERHEAT - per-8h funding |rate| above this = overheated. */
export const FUNDING_OVERHEAT = 0.0005
/** @constant {number} MOMENTUM_UP_PCT - 24h change above this = positive momentum. */
export const MOMENTUM_UP_PCT = 3
/** @constant {number} MOMENTUM_DOWN_PCT - 24h change below this = negative momentum. */
export const MOMENTUM_DOWN_PCT = -3
/** @constant {number} UP_VOTES_BULL_PCT - community up-vote share above this = bullish. */
export const UP_VOTES_BULL_PCT = 60
/** @constant {number} UP_VOTES_BEAR_PCT - community up-vote share below this = bearish. */
export const UP_VOTES_BEAR_PCT = 40
/** @constant {number} SUPPLY_UNLOCKED_HIGH - total/max supply ratio at/above this = mostly unlocked. */
export const SUPPLY_UNLOCKED_HIGH = 0.9
/** @constant {number} SUPPLY_UNLOCKED_LOW - total/max supply ratio at/below this = heavy future unlock. */
export const SUPPLY_UNLOCKED_LOW = 0.5
/** @constant {number} INFLATION_BEAR_PCT - inflation rate above this = bearish. */
export const INFLATION_BEAR_PCT = 10
/** @constant {number} DEV_COMMITS_BULL - 4-week commit count above this = active development. */
export const DEV_COMMITS_BULL = 50
/** @constant {number} ATH_DISCOUNT_PCT - drawdown from ATH at/below this = deep discount. */
export const ATH_DISCOUNT_PCT = -70
/** @constant {number} ATH_FROTH_PCT - drawdown from ATH at/above this = near ATH froth. */
export const ATH_FROTH_PCT = -10

/** @constant {number} NEUTRAL_BASELINE - score before any component deltas. */
const NEUTRAL_BASELINE = 50

/**
 * @function clampScore
 * @description Rounds and clamps a raw additive score into the [0,100] contract range.
 * @param {number} n - Raw score (may be negative or > 100).
 * @returns {number} Score clamped to [0,100].
 */
function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * @function insufficientData
 * @description Emits the canonical "no usable data" result for an empty factor input.
 *   Score 0 signals "nothing evaluated" — distinct from a genuine bearish 0.
 * @param {string} factor - Factor name.
 * @returns {FactorScore} Score 0 with a single neutral signal.
 */
function insufficientData(factor: string): FactorScore {
  return { factor, score: 0, signals: [{ name: "insufficient data", type: "neutral", detail: "no usable indicator data" }] }
}

// --- Technical ---------------------------------------------------------------

/**
 * @typedef {Object} RsiData
 * @description Structured get_rsi tool output.
 * @property {number[]} values - Full RSI series.
 * @property {number | null} latest - Most recent RSI value, or null when unavailable.
 */
export interface RsiData {
  values: number[]
  latest: number | null
}

/**
 * @typedef {Object} MacdData
 * @description Structured get_macd tool output.
 * @property {Array<{ MACD: number | null; signal: number | null; histogram: number | null }>} values
 * @property {{ MACD: number | null; signal: number | null; histogram: number | null } | null} latest
 */
export interface MacdData {
  values: Array<{ MACD: number | null; signal: number | null; histogram: number | null }>
  latest: { MACD: number | null; signal: number | null; histogram: number | null } | null
}

/**
 * @typedef {Object} BbData
 * @description Structured get_bb tool output.
 * @property {Array<{ upper: number; middle: number; lower: number }>} values
 * @property {{ upper: number; middle: number; lower: number } | null} latest
 * @property {number | null} latestClose - Last close price used for band position (%B).
 */
export interface BbData {
  values: Array<{ upper: number; middle: number; lower: number }>
  latest: { upper: number; middle: number; lower: number } | null
  latestClose: number | null
}

/**
 * @typedef {Object} StochData
 * @description Structured get_stoch tool output.
 * @property {Array<{ k: number; d: number }>} values
 * @property {{ k: number; d: number } | null} latest
 */
export interface StochData {
  values: Array<{ k: number; d: number }>
  latest: { k: number; d: number } | null
}

/**
 * @typedef {Object} VolumeData
 * @description Structured get_volume tool output.
 * @property {number} avgVolume - Average volume.
 * @property {number} currentVolume - Latest bar volume.
 * @property {number} volumeRatio - currentVolume / avgVolume.
 * @property {"increasing" | "decreasing" | "neutral"} trend - Recent volume trend.
 */
export interface VolumeData {
  avgVolume: number
  currentVolume: number
  volumeRatio: number
  trend: "increasing" | "decreasing" | "neutral"
}

/**
 * @typedef {Object} DivergenceData
 * @description Structured get_divergence tool output (booleans may both be false).
 * @property {boolean} regularBearish - Price higher high, indicator lower high.
 * @property {boolean} regularBullish - Price lower low, indicator higher low.
 * @property {boolean} hiddenBearish - Price lower high, indicator higher high.
 * @property {boolean} hiddenBullish - Price higher low, indicator lower low.
 */
export interface DivergenceData {
  regularBearish: boolean
  regularBullish: boolean
  hiddenBearish: boolean
  hiddenBullish: boolean
}

/**
 * @typedef {Object} TechnicalScoreInput
 * @description All technical tool data available for scoring. Every field optional —
 *   missing indicators are simply skipped, so partial tool coverage still scores.
 */
export interface TechnicalScoreInput {
  rsi?: RsiData
  macd?: MacdData
  bb?: BbData
  stoch?: StochData
  volume?: VolumeData
  divergence?: DivergenceData
}

/**
 * @function rsiComponent
 * @description RSI formula: RSI < 30 → oversold contrarian buy (+25); RSI > 70 →
 *   overbought (−25); otherwise neutral (0). Weight 25.
 * @param {RsiData | undefined} rsi - Structured RSI data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function rsiComponent(rsi: RsiData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const latest = rsi?.latest ?? null
  if (latest === null || !Number.isFinite(latest)) return { signal: null, delta: 0, evaluated: false }
  if (latest < RSI_OVERSOLD) {
    return { signal: { name: "RSI oversold", type: "bullish", value: latest, detail: `RSI ${latest} < ${RSI_OVERSOLD}` }, delta: 25, evaluated: true }
  }
  if (latest > RSI_OVERBOUGHT) {
    return { signal: { name: "RSI overbought", type: "bearish", value: latest, detail: `RSI ${latest} > ${RSI_OVERBOUGHT}` }, delta: -25, evaluated: true }
  }
  return { signal: { name: "RSI neutral", type: "neutral", value: latest }, delta: 0, evaluated: true }
}

/**
 * @function macdComponent
 * @description MACD formula: histogram > 0 → bullish momentum (+15); histogram < 0 →
 *   bearish momentum (−15); zero → neutral. Weight 15.
 * @param {MacdData | undefined} macd - Structured MACD data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function macdComponent(macd: MacdData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const hist = macd?.latest?.histogram ?? null
  if (hist === null || !Number.isFinite(hist)) return { signal: null, delta: 0, evaluated: false }
  if (hist > 0) return { signal: { name: "MACD positive", type: "bullish", value: hist }, delta: 15, evaluated: true }
  if (hist < 0) return { signal: { name: "MACD negative", type: "bearish", value: hist }, delta: -15, evaluated: true }
  return { signal: { name: "MACD flat", type: "neutral", value: hist }, delta: 0, evaluated: true }
}

/**
 * @function bbComponent
 * @description Bollinger formula: %B = (latestClose − lower)/(upper − lower). %B > 1 →
 *   close above upper band, overextended bearish (−15); %B < 0 → close below lower
 *   band, mean-reversion bullish (+15); else neutral. Guards upper === lower (÷0).
 *   Weight 15.
 * @param {BbData | undefined} bb - Structured Bollinger data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function bbComponent(bb: BbData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const latest = bb?.latest
  const close = bb?.latestClose ?? null
  if (!latest || close === null || !Number.isFinite(close)) return { signal: null, delta: 0, evaluated: false }
  const width = latest.upper - latest.lower
  if (width === 0) return { signal: { name: "Price within Bollinger bands", type: "neutral" }, delta: 0, evaluated: true }
  const pctB = (close - latest.lower) / width
  const rounded = Math.round(pctB * 100) / 100
  if (pctB > 1) {
    return { signal: { name: "Price above upper Bollinger band", type: "bearish", value: rounded }, delta: -15, evaluated: true }
  }
  if (pctB < 0) {
    return { signal: { name: "Price below lower Bollinger band", type: "bullish", value: rounded }, delta: 15, evaluated: true }
  }
  return { signal: { name: "Price within Bollinger bands", type: "neutral", value: rounded }, delta: 0, evaluated: true }
}

/**
 * @function stochComponent
 * @description Stochastic formula: %K < 20 → oversold bullish (+10); %K > 80 →
 *   overbought bearish (−10); else neutral. Weight 10.
 * @param {StochData | undefined} stoch - Structured Stochastic data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function stochComponent(stoch: StochData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const k = stoch?.latest?.k ?? null
  if (k === null || !Number.isFinite(k)) return { signal: null, delta: 0, evaluated: false }
  if (k < STOCH_OVERSOLD) return { signal: { name: "Stochastic oversold", type: "bullish", value: k }, delta: 10, evaluated: true }
  if (k > STOCH_OVERBOUGHT) return { signal: { name: "Stochastic overbought", type: "bearish", value: k }, delta: -10, evaluated: true }
  return { signal: { name: "Stochastic neutral", type: "neutral", value: k }, delta: 0, evaluated: true }
}

/**
 * @function volumeComponent
 * @description Volume formula: volume spike (ratio > 1.5) with rising trend → confirms
 *   trend, bullish (+15); spike with falling trend → fade, bearish (−15); else neutral.
 *   Weight 15.
 * @param {VolumeData | undefined} volume - Structured volume data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function volumeComponent(volume: VolumeData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!volume || !Number.isFinite(volume.volumeRatio)) return { signal: null, delta: 0, evaluated: false }
  if (volume.volumeRatio > VOLUME_SPIKE_RATIO) {
    if (volume.trend === "increasing") {
      return { signal: { name: "Volume surge confirms trend", type: "bullish", value: volume.volumeRatio }, delta: 15, evaluated: true }
    }
    if (volume.trend === "decreasing") {
      return { signal: { name: "Volume surge with fading price", type: "bearish", value: volume.volumeRatio }, delta: -15, evaluated: true }
    }
  }
  return { signal: { name: "Volume neutral", type: "neutral", value: volume.volumeRatio }, delta: 0, evaluated: true }
}

/**
 * @function divergenceComponent
 * @description Divergence formula (priority order, single match): regular bearish −20,
 *   regular bullish +20, hidden bearish −10, hidden bullish +10, else neutral.
 *   Weight 20.
 * @param {DivergenceData | undefined} divergence - Structured divergence data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function divergenceComponent(divergence: DivergenceData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!divergence) return { signal: null, delta: 0, evaluated: false }
  if (divergence.regularBearish) return { signal: { name: "Regular bearish divergence", type: "bearish" }, delta: -20, evaluated: true }
  if (divergence.regularBullish) return { signal: { name: "Regular bullish divergence", type: "bullish" }, delta: 20, evaluated: true }
  if (divergence.hiddenBearish) return { signal: { name: "Hidden bearish divergence", type: "bearish" }, delta: -10, evaluated: true }
  if (divergence.hiddenBullish) return { signal: { name: "Hidden bullish divergence", type: "bullish" }, delta: 10, evaluated: true }
  return { signal: { name: "No divergence", type: "neutral" }, delta: 0, evaluated: true }
}

/**
 * @function scoreTechnical
 * @description Scores the technical factor deterministically from structured indicator
 *   data. Baseline 50, additive component deltas (RSI ±25, MACD ±15, BB ±15, Stoch ±10,
 *   Volume ±15, Divergence ±20), clamped to [0,100]. Missing indicators are skipped;
 *   when nothing is evaluable the score is 0 with an "insufficient data" signal.
 * @param {TechnicalScoreInput} input - Structured technical tool outputs.
 * @returns {FactorScore} Deterministic technical factor score and signals.
 */
export function scoreTechnical(input: TechnicalScoreInput): FactorScore {
  const components = [rsiComponent(input.rsi), macdComponent(input.macd), bbComponent(input.bb), stochComponent(input.stoch), volumeComponent(input.volume), divergenceComponent(input.divergence)]
  const evaluated = components.filter((c) => c.evaluated)
  if (evaluated.length === 0) return insufficientData("technical")
  const delta = evaluated.reduce((sum, c) => sum + c.delta, 0)
  const signals = evaluated.map((c) => c.signal as Signal)
  return { factor: "technical", score: clampScore(NEUTRAL_BASELINE + delta), signals }
}

// --- Sentiment ---------------------------------------------------------------

/**
 * @typedef {Object} FearGreedData
 * @description Structured get_fear_greed tool output.
 * @property {number | null} value - Fear & Greed index 0-100.
 * @property {string | null} classification - e.g. "Fear", "Greed", "Neutral".
 */
export interface FearGreedData {
  value: number | null
  classification: string | null
}

/**
 * @typedef {Object} CoinSentimentData
 * @description Structured get_coin_sentiment tool output.
 * @property {string} coinId - CoinGecko id.
 * @property {number | null} votesUp - Community up votes.
 * @property {number | null} votesDown - Community down votes.
 * @property {number | null} upPercent - Up-vote share (0-100).
 * @property {number | null} downPercent - Down-vote share (0-100).
 */
export interface CoinSentimentData {
  coinId: string
  votesUp: number | null
  votesDown: number | null
  upPercent: number | null
  downPercent: number | null
}

/**
 * @typedef {Object} MomentumData
 * @description Structured get_asset_momentum tool output (subset consumed by scoring).
 * @property {number | null} percent_change_24h - 24h price change percent.
 */
export interface MomentumData {
  price_usd: number | null
  percent_change_1h: number | null
  percent_change_24h: number | null
  percent_change_7d: number | null
  volume_24h_usd: number | null
}

/**
 * @typedef {Object} FundingData
 * @description Structured get_funding_rate tool output (subset consumed by scoring).
 * @property {number} fundingRate - Current per-8h funding rate (decimal).
 */
export interface FundingData {
  fundingRate: number
}

/**
 * @typedef {Object} SentimentScoreInput
 * @description All sentiment tool data available for scoring. Every field optional.
 */
export interface SentimentScoreInput {
  fearGreed?: FearGreedData
  coinSentiment?: CoinSentimentData
  momentum?: MomentumData
  funding?: FundingData
}

/**
 * @function fundingComponent
 * @description Funding formula: rate > +0.05% per 8h → crowded long, bearish (−30);
 *   rate < −0.05% → crowded short, contrarian bullish (+30); else neutral. Weight 30.
 *   Overheat threshold mirrors the perp-funding-basis skill (> +0.05%/8h).
 * @param {FundingData | undefined} funding - Structured funding data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function fundingComponent(funding: FundingData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!funding || !Number.isFinite(funding.fundingRate)) return { signal: null, delta: 0, evaluated: false }
  if (funding.fundingRate > FUNDING_OVERHEAT) {
    return { signal: { name: "Crowded long (funding overheated)", type: "bearish", value: funding.fundingRate }, delta: -30, evaluated: true }
  }
  if (funding.fundingRate < -FUNDING_OVERHEAT) {
    return { signal: { name: "Crowded short (contrarian long)", type: "bullish", value: funding.fundingRate }, delta: 30, evaluated: true }
  }
  return { signal: { name: "Funding neutral", type: "neutral", value: funding.fundingRate }, delta: 0, evaluated: true }
}

/**
 * @function fearGreedComponent
 * @description Fear & Greed formula: index < 30 → extreme fear, contrarian buy (+30);
 *   index > 70 → extreme greed, froth bearish (−30); else neutral. Weight 30.
 * @param {FearGreedData | undefined} fg - Structured Fear & Greed data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function fearGreedComponent(fg: FearGreedData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const value = fg?.value ?? null
  if (value === null || !Number.isFinite(value)) return { signal: null, delta: 0, evaluated: false }
  if (value < 30) return { signal: { name: "Extreme fear (contrarian buy)", type: "bullish", value }, delta: 30, evaluated: true }
  if (value > 70) return { signal: { name: "Extreme greed (froth)", type: "bearish", value }, delta: -30, evaluated: true }
  return { signal: { name: "Fear/Greed neutral", type: "neutral", value }, delta: 0, evaluated: true }
}

/**
 * @function coinSentimentComponent
 * @description Community vote formula: up-vote share > 60% → bullish (+20); < 40% →
 *   bearish (−20); else mixed. Weight 20.
 * @param {CoinSentimentData | undefined} cs - Structured coin sentiment data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function coinSentimentComponent(cs: CoinSentimentData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const up = cs?.upPercent ?? null
  if (up === null || !Number.isFinite(up)) return { signal: null, delta: 0, evaluated: false }
  if (up > UP_VOTES_BULL_PCT) return { signal: { name: "Community sentiment bullish", type: "bullish", value: up }, delta: 20, evaluated: true }
  if (up < UP_VOTES_BEAR_PCT) return { signal: { name: "Community sentiment bearish", type: "bearish", value: up }, delta: -20, evaluated: true }
  return { signal: { name: "Community sentiment mixed", type: "neutral", value: up }, delta: 0, evaluated: true }
}

/**
 * @function momentumComponent
 * @description Momentum formula: 24h change > +3% → bullish (+20); < −3% → bearish
 *   (−20); else flat. Weight 20.
 * @param {MomentumData | undefined} momentum - Structured asset momentum data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function momentumComponent(momentum: MomentumData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const change = momentum?.percent_change_24h ?? null
  if (change === null || !Number.isFinite(change)) return { signal: null, delta: 0, evaluated: false }
  if (change > MOMENTUM_UP_PCT) return { signal: { name: "Momentum positive", type: "bullish", value: change }, delta: 20, evaluated: true }
  if (change < MOMENTUM_DOWN_PCT) return { signal: { name: "Momentum negative", type: "bearish", value: change }, delta: -20, evaluated: true }
  return { signal: { name: "Momentum flat", type: "neutral", value: change }, delta: 0, evaluated: true }
}

/**
 * @function scoreSentiment
 * @description Scores the sentiment factor deterministically. Baseline 50, additive
 *   component deltas (Fear & Greed ±30, Funding ±30, Community votes ±20, Momentum ±20),
 *   clamped to [0,100]. Missing inputs skipped; nothing evaluable → score 0.
 * @param {SentimentScoreInput} input - Structured sentiment tool outputs.
 * @returns {FactorScore} Deterministic sentiment factor score and signals.
 */
export function scoreSentiment(input: SentimentScoreInput): FactorScore {
  const components = [fearGreedComponent(input.fearGreed), fundingComponent(input.funding), coinSentimentComponent(input.coinSentiment), momentumComponent(input.momentum)]
  const evaluated = components.filter((c) => c.evaluated)
  if (evaluated.length === 0) return insufficientData("sentiment")
  const delta = evaluated.reduce((sum, c) => sum + c.delta, 0)
  const signals = evaluated.map((c) => c.signal as Signal)
  return { factor: "sentiment", score: clampScore(NEUTRAL_BASELINE + delta), signals }
}

// --- Onchain -----------------------------------------------------------------

/**
 * @typedef {Object} OiDivergenceData
 * @description Structured OI/funding divergence output (from funding-regime analysis).
 * @property {boolean} divergence - Whether a divergence was detected.
 * @property {number} priceChangePct - 24h price change percent.
 * @property {number} oiChangePct - OI turnover proxy percent.
 * @property {number} fundingRate - Current funding rate (decimal).
 * @property {"bullish" | "bearish" | "neutral"} signal - Divergence direction.
 */
export interface OiDivergenceData {
  divergence: boolean
  priceChangePct: number
  oiChangePct: number
  fundingRate: number
  signal: "bullish" | "bearish" | "neutral"
}

/**
 * @typedef {Object} ExchangeFlowData
 * @description Structured get_exchange_flow tool output.
 * @property {string} asset - Asset ticker.
 * @property {number} inflow - USD inflow to exchanges.
 * @property {number} outflow - USD outflow from exchanges.
 * @property {number} netflow - inflow − outflow (positive = net exchange inflow).
 */
export interface ExchangeFlowData {
  asset: string
  inflow: number
  outflow: number
  netflow: number
}

/**
 * @typedef {Object} WhaleTxnsData
 * @description Structured get_whale_txns tool output.
 * @property {string} asset - Asset ticker.
 * @property {Array<{ hash: string; value: number }>} transactions - Whale transactions.
 */
export interface WhaleTxnsData {
  asset: string
  transactions: Array<{ hash: string; value: number }>
}

/**
 * @typedef {Object} OnchainScoreInput
 * @description All onchain tool data available for scoring. Every field optional.
 */
export interface OnchainScoreInput {
  funding?: FundingData
  oiDivergence?: OiDivergenceData
  exchangeFlow?: ExchangeFlowData
  whaleTxns?: WhaleTxnsData
}

/**
 * @function oiDivergenceComponent
 * @description OI divergence formula: signal bullish → +30; bearish → −30; neutral → 0.
 *   Weight 30.
 * @param {OiDivergenceData | undefined} oi - Structured divergence data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function oiDivergenceComponent(oi: OiDivergenceData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!oi) return { signal: null, delta: 0, evaluated: false }
  if (oi.signal === "bullish") return { signal: { name: "OI divergence bullish", type: "bullish" }, delta: 30, evaluated: true }
  if (oi.signal === "bearish") return { signal: { name: "OI divergence bearish", type: "bearish" }, delta: -30, evaluated: true }
  return { signal: { name: "OI divergence neutral", type: "neutral" }, delta: 0, evaluated: true }
}

/**
 * @function exchangeFlowComponent
 * @description Exchange flow formula: netflow > 0 → exchange inflow, sell pressure
 *   bearish (−30); netflow < 0 → exchange outflow, accumulation bullish (+30);
 *   netflow 0 → neutral. Weight 30.
 * @param {ExchangeFlowData | undefined} flow - Structured exchange flow data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function exchangeFlowComponent(flow: ExchangeFlowData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!flow || !Number.isFinite(flow.netflow)) return { signal: null, delta: 0, evaluated: false }
  if (flow.netflow > 0) return { signal: { name: "Exchange inflow (sell pressure)", type: "bearish", value: flow.netflow }, delta: -30, evaluated: true }
  if (flow.netflow < 0) return { signal: { name: "Exchange outflow (accumulation)", type: "bullish", value: flow.netflow }, delta: 30, evaluated: true }
  return { signal: { name: "Exchange flow neutral", type: "neutral", value: flow.netflow }, delta: 0, evaluated: true }
}

/**
 * @function whaleComponent
 * @description Whale activity formula: 3+ whale transactions in the window → mildly
 *   bullish (+10, active accumulation attention); fewer → neutral. MVP data has no
 *   buy/sell direction, so this is a weak positive at best. Weight 10.
 * @param {WhaleTxnsData | undefined} whale - Structured whale transaction data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function whaleComponent(whale: WhaleTxnsData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  if (!whale || !Array.isArray(whale.transactions)) return { signal: null, delta: 0, evaluated: false }
  const count = whale.transactions.length
  if (count >= 3) return { signal: { name: "Elevated whale activity", type: "bullish", value: count }, delta: 10, evaluated: true }
  return { signal: { name: "Whale activity low", type: "neutral", value: count }, delta: 0, evaluated: true }
}

/**
 * @function scoreOnchain
 * @description Scores the onchain factor deterministically. Baseline 50, additive
 *   component deltas (Funding ±30, OI divergence ±30, Exchange flow ±30, Whale ±10),
 *   clamped to [0,100]. Missing inputs skipped; nothing evaluable → score 0.
 * @param {OnchainScoreInput} input - Structured onchain tool outputs.
 * @returns {FactorScore} Deterministic onchain factor score and signals.
 */
export function scoreOnchain(input: OnchainScoreInput): FactorScore {
  const components = [fundingComponent(input.funding), oiDivergenceComponent(input.oiDivergence), exchangeFlowComponent(input.exchangeFlow), whaleComponent(input.whaleTxns)]
  const evaluated = components.filter((c) => c.evaluated)
  if (evaluated.length === 0) return insufficientData("onchain")
  const delta = evaluated.reduce((sum, c) => sum + c.delta, 0)
  const signals = evaluated.map((c) => c.signal as Signal)
  return { factor: "onchain", score: clampScore(NEUTRAL_BASELINE + delta), signals }
}

// --- Fundamental -------------------------------------------------------------

/**
 * @typedef {Object} TokenomicsData
 * @description Structured get_tokenomics tool output (subset consumed by scoring).
 * @property {number | null} circulatingSupply
 * @property {number | null} totalSupply
 * @property {number | null} maxSupply
 * @property {Array<{ date: string; amount: number }>} unlockEvents
 */
export interface TokenomicsData {
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  unlockEvents: Array<{ date: string; amount: number }>
}

/**
 * @typedef {Object} InflationData
 * @description Structured get_inflation_data tool output (subset consumed by scoring).
 * @property {number | null} currentRatePercent - Current annual inflation percent.
 */
export interface InflationData {
  currentRatePercent: number | null
  nextRateChangeDate: string | null
  nextRatePercent: number | null
  historical: Array<{ date: string; rate_percent: number }>
}

/**
 * @typedef {Object} DevActivityData
 * @description Structured get_developer_activity tool output (subset consumed by scoring).
 * @property {number | null} commitCount4Weeks - GitHub commits in the last 4 weeks.
 */
export interface DevActivityData {
  forks: number | null
  stars: number | null
  subscribers: number | null
  totalIssues: number | null
  closedIssues: number | null
  pullRequestsMerged: number | null
  commitCount4Weeks: number | null
}

/**
 * @typedef {Object} AthData
 * @description Structured get_ath tool output (subset consumed by scoring).
 * @property {number | null} athUsd - All-time-high price.
 * @property {number | null} athChangePercent - Current drawdown % from ATH (negative).
 */
export interface AthData {
  athUsd: number | null
  athChangePercent: number | null
  athDate: string | null
}

/**
 * @typedef {Object} FundamentalScoreInput
 * @description All fundamental tool data available for scoring. Every field optional.
 */
export interface FundamentalScoreInput {
  tokenomics?: TokenomicsData
  inflation?: InflationData
  devActivity?: DevActivityData
  ath?: AthData
}

/**
 * @function tokenomicsComponent
 * @description Supply unlock formula: ratio = totalSupply/maxSupply. Ratio ≥ 0.9 →
 *   supply mostly unlocked, low future dilution bullish (+30); ratio ≤ 0.5 → heavy
 *   future unlock risk bearish (−30); else neutral. Uncomputable ratio (missing
 *   supplies or maxSupply 0) → not evaluated. Weight 30.
 * @param {TokenomicsData | undefined} tokenomics - Structured tokenomics data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function tokenomicsComponent(tokenomics: TokenomicsData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const total = tokenomics?.totalSupply ?? null
  const max = tokenomics?.maxSupply ?? null
  if (total === null || max === null || max <= 0 || !Number.isFinite(total) || !Number.isFinite(max)) {
    return { signal: null, delta: 0, evaluated: false }
  }
  const ratio = total / max
  const rounded = Math.round(ratio * 100) / 100
  if (ratio >= SUPPLY_UNLOCKED_HIGH) {
    return { signal: { name: "Supply mostly unlocked", type: "bullish", value: rounded }, delta: 30, evaluated: true }
  }
  if (ratio <= SUPPLY_UNLOCKED_LOW) {
    return { signal: { name: "Large future unlock risk", type: "bearish", value: rounded }, delta: -30, evaluated: true }
  }
  return { signal: { name: "Supply unlock neutral", type: "neutral", value: rounded }, delta: 0, evaluated: true }
}

/**
 * @function inflationComponent
 * @description Inflation formula: rate > 10% → supply growth bearish (−30); rate < 0 →
 *   deflationary bullish (+30); else neutral. Weight 30.
 * @param {InflationData | undefined} inflation - Structured inflation data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function inflationComponent(inflation: InflationData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const rate = inflation?.currentRatePercent ?? null
  if (rate === null || !Number.isFinite(rate)) return { signal: null, delta: 0, evaluated: false }
  if (rate > INFLATION_BEAR_PCT) return { signal: { name: "High inflation", type: "bearish", value: rate }, delta: -30, evaluated: true }
  if (rate < 0) return { signal: { name: "Deflationary", type: "bullish", value: rate }, delta: 30, evaluated: true }
  return { signal: { name: "Inflation neutral", type: "neutral", value: rate }, delta: 0, evaluated: true }
}

/**
 * @function devActivityComponent
 * @description Development formula: 4-week commit count > 50 → active development
 *   bullish (+20); else quiet neutral. Weight 20.
 * @param {DevActivityData | undefined} dev - Structured developer activity data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function devActivityComponent(dev: DevActivityData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const commits = dev?.commitCount4Weeks ?? null
  if (commits === null || !Number.isFinite(commits)) return { signal: null, delta: 0, evaluated: false }
  if (commits > DEV_COMMITS_BULL) {
    return { signal: { name: "Active development", type: "bullish", value: commits }, delta: 20, evaluated: true }
  }
  return { signal: { name: "Development quiet", type: "neutral", value: commits }, delta: 0, evaluated: true }
}

/**
 * @function athComponent
 * @description ATH drawdown formula: drawdown ≤ −70% → deep discount, contrarian
 *   bullish (+20); drawdown ≥ −10% → near ATH froth bearish (−20); else neutral.
 *   Weight 20.
 * @param {AthData | undefined} ath - Structured ATH data.
 * @returns {{ signal: Signal | null; delta: number; evaluated: boolean }} Component result.
 */
function athComponent(ath: AthData | undefined): { signal: Signal | null; delta: number; evaluated: boolean } {
  const change = ath?.athChangePercent ?? null
  if (change === null || !Number.isFinite(change)) return { signal: null, delta: 0, evaluated: false }
  if (change <= ATH_DISCOUNT_PCT) return { signal: { name: "Deep discount to ATH", type: "bullish", value: change }, delta: 20, evaluated: true }
  if (change >= ATH_FROTH_PCT) return { signal: { name: "Near ATH (froth risk)", type: "bearish", value: change }, delta: -20, evaluated: true }
  return { signal: { name: "ATH drawdown neutral", type: "neutral", value: change }, delta: 0, evaluated: true }
}

/**
 * @function scoreFundamental
 * @description Scores the fundamental factor deterministically. Baseline 50, additive
 *   component deltas (Tokenomics ±30, Inflation ±30, Dev activity ±20, ATH drawdown
 *   ±20), clamped to [0,100]. Missing inputs skipped; nothing evaluable → score 0.
 * @param {FundamentalScoreInput} input - Structured fundamental tool outputs.
 * @returns {FactorScore} Deterministic fundamental factor score and signals.
 */
export function scoreFundamental(input: FundamentalScoreInput): FactorScore {
  const components = [tokenomicsComponent(input.tokenomics), inflationComponent(input.inflation), devActivityComponent(input.devActivity), athComponent(input.ath)]
  const evaluated = components.filter((c) => c.evaluated)
  if (evaluated.length === 0) return insufficientData("fundamental")
  const delta = evaluated.reduce((sum, c) => sum + c.delta, 0)
  const signals = evaluated.map((c) => c.signal as Signal)
  return { factor: "fundamental", score: clampScore(NEUTRAL_BASELINE + delta), signals }
}
