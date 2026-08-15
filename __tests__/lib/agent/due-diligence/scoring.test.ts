/**
 * @file __tests__/lib/agent/due-diligence/scoring.test.ts
 * @description Deterministic factor scoring tests. Verifies the pure scoring module
 *   (lib/agent/due-diligence/scoring.ts) converts structured tool data into
 *   0-100 factor scores and typed signals with clamped [0,100] output.
 * @module tests
 */

import { describe, it, expect } from "vitest"
import {
  scoreTechnical,
  scoreSentiment,
  scoreOnchain,
  scoreFundamental,
} from "@/lib/agent/due-diligence/scoring"

describe("scoreTechnical", () => {
  it("returns score 0 and an insufficient-data signal for empty input", () => {
    const result = scoreTechnical({})
    expect(result.factor).toBe("technical")
    expect(result.score).toBe(0)
    expect(result.signals).toHaveLength(1)
    expect(result.signals[0]).toMatchObject({ name: "insufficient data", type: "neutral" })
  })

  it("scores RSI oversold (< 30) as bullish (+25)", () => {
    const result = scoreTechnical({ rsi: { values: [], latest: 25 } })
    expect(result.score).toBe(75)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "RSI oversold", type: "bullish", value: 25 })
    )
  })

  it("scores RSI overbought (> 70) as bearish (-25)", () => {
    const result = scoreTechnical({ rsi: { values: [], latest: 80 } })
    expect(result.score).toBe(25)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "RSI overbought", type: "bearish", value: 80 })
    )
  })

  it("treats RSI in the neutral band as neutral", () => {
    const result = scoreTechnical({ rsi: { values: [], latest: 50 } })
    expect(result.score).toBe(50)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "RSI neutral", type: "neutral" })
    )
  })

  it("treats a null RSI latest as missing data (score 0)", () => {
    const result = scoreTechnical({ rsi: { values: [], latest: null } })
    expect(result.score).toBe(0)
    expect(result.signals[0].name).toBe("insufficient data")
  })

  it("scores positive MACD histogram as bullish (+15)", () => {
    const result = scoreTechnical({
      macd: { values: [], latest: { MACD: 5, signal: 1, histogram: 4 } },
    })
    expect(result.score).toBe(65)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "MACD positive", type: "bullish", value: 4 })
    )
  })

  it("scores negative MACD histogram as bearish (-15)", () => {
    const result = scoreTechnical({
      macd: { values: [], latest: { MACD: 1, signal: 5, histogram: -4 } },
    })
    expect(result.score).toBe(35)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "MACD negative", type: "bearish" })
    )
  })

  it("scores Stochastic oversold (< 20) as bullish (+10)", () => {
    const result = scoreTechnical({ stoch: { values: [], latest: { k: 15, d: 20 } } })
    expect(result.score).toBe(60)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Stochastic oversold", type: "bullish" })
    )
  })

  it("scores Stochastic overbought (> 80) as bearish (-10)", () => {
    const result = scoreTechnical({ stoch: { values: [], latest: { k: 85, d: 80 } } })
    expect(result.score).toBe(40)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Stochastic overbought", type: "bearish" })
    )
  })

  it("scores price above upper Bollinger band as bearish (-15)", () => {
    const result = scoreTechnical({
      bb: { values: [], latest: { upper: 110, middle: 100, lower: 90 }, latestClose: 120 },
    })
    expect(result.score).toBe(35)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Price above upper Bollinger band", type: "bearish" })
    )
  })

  it("scores price below lower Bollinger band as bullish (+15)", () => {
    const result = scoreTechnical({
      bb: { values: [], latest: { upper: 110, middle: 100, lower: 90 }, latestClose: 80 },
    })
    expect(result.score).toBe(65)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Price below lower Bollinger band", type: "bullish" })
    )
  })

  it("guards against flat bands (upper === lower) division by zero", () => {
    const result = scoreTechnical({
      bb: { values: [], latest: { upper: 100, middle: 100, lower: 100 }, latestClose: 100 },
    })
    expect(result.score).toBe(50)
    expect(result.signals.some((s) => s.type === "neutral")).toBe(true)
  })

  it("scores volume surge with rising trend as bullish (+15)", () => {
    const result = scoreTechnical({
      volume: { avgVolume: 1000, currentVolume: 2000, volumeRatio: 2, trend: "increasing" },
    })
    expect(result.score).toBe(65)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Volume surge confirms trend", type: "bullish" })
    )
  })

  it("scores volume surge with falling trend as bearish (-15)", () => {
    const result = scoreTechnical({
      volume: { avgVolume: 1000, currentVolume: 2000, volumeRatio: 2, trend: "decreasing" },
    })
    expect(result.score).toBe(35)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Volume surge with fading price", type: "bearish" })
    )
  })

  it("keeps neutral score when volume ratio is not a spike", () => {
    const result = scoreTechnical({
      volume: { avgVolume: 1000, currentVolume: 1200, volumeRatio: 1.2, trend: "increasing" },
    })
    expect(result.score).toBe(50)
  })

  it("scores regular bearish divergence as bearish (-20)", () => {
    const result = scoreTechnical({
      divergence: { regularBearish: true, regularBullish: false, hiddenBearish: false, hiddenBullish: false },
    })
    expect(result.score).toBe(30)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Regular bearish divergence", type: "bearish" })
    )
  })

  it("scores regular bullish divergence as bullish (+20)", () => {
    const result = scoreTechnical({
      divergence: { regularBearish: false, regularBullish: true, hiddenBearish: false, hiddenBullish: false },
    })
    expect(result.score).toBe(70)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Regular bullish divergence", type: "bullish" })
    )
  })

  it("scores hidden bearish divergence as bearish (-10)", () => {
    const result = scoreTechnical({
      divergence: { regularBearish: false, regularBullish: false, hiddenBearish: true, hiddenBullish: false },
    })
    expect(result.score).toBe(40)
  })

  it("combines all-bullish indicators and clamps at 100", () => {
    const result = scoreTechnical({
      rsi: { values: [], latest: 25 },
      macd: { values: [], latest: { MACD: 5, signal: 1, histogram: 4 } },
      stoch: { values: [], latest: { k: 15, d: 20 } },
      bb: { values: [], latest: { upper: 110, middle: 100, lower: 90 }, latestClose: 80 },
      volume: { avgVolume: 1000, currentVolume: 2000, volumeRatio: 2, trend: "increasing" },
      divergence: { regularBearish: false, regularBullish: true, hiddenBearish: false, hiddenBullish: false },
    })
    expect(result.score).toBe(100)
    expect(result.signals).toHaveLength(6)
  })

  it("combines all-bearish indicators and clamps at 0", () => {
    const result = scoreTechnical({
      rsi: { values: [], latest: 80 },
      macd: { values: [], latest: { MACD: 1, signal: 5, histogram: -4 } },
      stoch: { values: [], latest: { k: 85, d: 80 } },
      bb: { values: [], latest: { upper: 110, middle: 100, lower: 90 }, latestClose: 120 },
      volume: { avgVolume: 1000, currentVolume: 2000, volumeRatio: 2, trend: "decreasing" },
      divergence: { regularBearish: true, regularBullish: false, hiddenBearish: false, hiddenBullish: false },
    })
    expect(result.score).toBe(0)
  })
})

describe("scoreSentiment", () => {
  it("returns score 0 and insufficient-data signal for empty input", () => {
    const result = scoreSentiment({})
    expect(result.factor).toBe("sentiment")
    expect(result.score).toBe(0)
    expect(result.signals[0]).toMatchObject({ name: "insufficient data", type: "neutral" })
  })

  it("scores extreme fear (< 30) as contrarian bullish (+30)", () => {
    const result = scoreSentiment({ fearGreed: { value: 20, classification: "Fear" } })
    expect(result.score).toBe(80)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Extreme fear (contrarian buy)", type: "bullish", value: 20 })
    )
  })

  it("scores extreme greed (> 70) as bearish (-30)", () => {
    const result = scoreSentiment({ fearGreed: { value: 80, classification: "Greed" } })
    expect(result.score).toBe(20)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Extreme greed (froth)", type: "bearish" })
    )
  })

  it("scores community bullish votes (> 60% up) as bullish (+20)", () => {
    const result = scoreSentiment({
      coinSentiment: { coinId: "bitcoin", votesUp: 75, votesDown: 25, upPercent: 75, downPercent: 25 },
    })
    expect(result.score).toBe(70)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Community sentiment bullish", type: "bullish" })
    )
  })

  it("scores community bearish votes (< 40% up) as bearish (-20)", () => {
    const result = scoreSentiment({
      coinSentiment: { coinId: "bitcoin", votesUp: 30, votesDown: 70, upPercent: 30, downPercent: 70 },
    })
    expect(result.score).toBe(30)
  })

  it("scores positive 24h momentum (> +3%) as bullish (+20)", () => {
    const result = scoreSentiment({
      momentum: { price_usd: 100, percent_change_1h: 1, percent_change_24h: 5, percent_change_7d: 10, volume_24h_usd: 1000000 },
    })
    expect(result.score).toBe(70)
  })

  it("scores negative 24h momentum (< -3%) as bearish (-20)", () => {
    const result = scoreSentiment({
      momentum: { price_usd: 100, percent_change_1h: -1, percent_change_24h: -5, percent_change_7d: -10, volume_24h_usd: 1000000 },
    })
    expect(result.score).toBe(30)
  })

  it("scores overheated long funding as bearish (-30)", () => {
    const result = scoreSentiment({ funding: { fundingRate: 0.001 } })
    expect(result.score).toBe(20)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Crowded long (funding overheated)", type: "bearish" })
    )
  })

  it("scores overheated short funding as contrarian bullish (+30)", () => {
    const result = scoreSentiment({ funding: { fundingRate: -0.001 } })
    expect(result.score).toBe(80)
  })

  it("clamps all-bullish sentiment to 100", () => {
    const result = scoreSentiment({
      fearGreed: { value: 20, classification: "Fear" },
      coinSentiment: { coinId: "bitcoin", votesUp: 75, votesDown: 25, upPercent: 75, downPercent: 25 },
      momentum: { price_usd: 100, percent_change_1h: 1, percent_change_24h: 5, percent_change_7d: 10, volume_24h_usd: 1000000 },
      funding: { fundingRate: -0.001 },
    })
    expect(result.score).toBe(100)
  })

  it("clamps all-bearish sentiment to 0", () => {
    const result = scoreSentiment({
      fearGreed: { value: 80, classification: "Greed" },
      coinSentiment: { coinId: "bitcoin", votesUp: 30, votesDown: 70, upPercent: 30, downPercent: 70 },
      momentum: { price_usd: 100, percent_change_1h: -1, percent_change_24h: -5, percent_change_7d: -10, volume_24h_usd: 1000000 },
      funding: { fundingRate: 0.001 },
    })
    expect(result.score).toBe(0)
  })
})

describe("scoreOnchain", () => {
  it("returns score 0 and insufficient-data signal for empty input", () => {
    const result = scoreOnchain({})
    expect(result.factor).toBe("onchain")
    expect(result.score).toBe(0)
    expect(result.signals[0]).toMatchObject({ name: "insufficient data", type: "neutral" })
  })

  it("scores overheated long funding as bearish (-30)", () => {
    const result = scoreOnchain({ funding: { fundingRate: 0.001 } })
    expect(result.score).toBe(20)
  })

  it("scores overheated short funding as bullish (+30)", () => {
    const result = scoreOnchain({ funding: { fundingRate: -0.001 } })
    expect(result.score).toBe(80)
  })

  it("scores bullish OI divergence as bullish (+30)", () => {
    const result = scoreOnchain({
      oiDivergence: { divergence: true, priceChangePct: -2, oiChangePct: 1, fundingRate: 0.001, signal: "bullish" },
    })
    expect(result.score).toBe(80)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "OI divergence bullish", type: "bullish" })
    )
  })

  it("scores bearish OI divergence as bearish (-30)", () => {
    const result = scoreOnchain({
      oiDivergence: { divergence: true, priceChangePct: 2, oiChangePct: 1, fundingRate: -0.001, signal: "bearish" },
    })
    expect(result.score).toBe(20)
  })

  it("scores exchange inflow as bearish (-30)", () => {
    const result = scoreOnchain({ exchangeFlow: { asset: "BTC", inflow: 15, outflow: 12, netflow: 3 } })
    expect(result.score).toBe(20)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Exchange inflow (sell pressure)", type: "bearish" })
    )
  })

  it("scores exchange outflow as bullish (+30)", () => {
    const result = scoreOnchain({ exchangeFlow: { asset: "BTC", inflow: 12, outflow: 15, netflow: -3 } })
    expect(result.score).toBe(80)
  })

  it("scores elevated whale activity as mildly bullish (+10)", () => {
    const result = scoreOnchain({
      whaleTxns: { asset: "BTC", transactions: [{ hash: "a", value: 100 }, { hash: "b", value: 200 }, { hash: "c", value: 300 }] },
    })
    expect(result.score).toBe(60)
  })

  it("keeps neutral score for low whale activity", () => {
    const result = scoreOnchain({ whaleTxns: { asset: "BTC", transactions: [{ hash: "a", value: 100 }] } })
    expect(result.score).toBe(50)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Whale activity low", type: "neutral" })
    )
  })

  it("clamps all-bearish onchain data to 0", () => {
    const result = scoreOnchain({
      funding: { fundingRate: 0.001 },
      oiDivergence: { divergence: true, priceChangePct: 2, oiChangePct: 1, fundingRate: 0.001, signal: "bearish" },
      exchangeFlow: { asset: "BTC", inflow: 15, outflow: 12, netflow: 3 },
    })
    expect(result.score).toBe(0)
  })
})

describe("scoreFundamental", () => {
  it("returns score 0 and insufficient-data signal for empty input", () => {
    const result = scoreFundamental({})
    expect(result.factor).toBe("fundamental")
    expect(result.score).toBe(0)
    expect(result.signals[0]).toMatchObject({ name: "insufficient data", type: "neutral" })
  })

  it("scores high unlocked supply ratio (>= 0.9) as bullish (+30)", () => {
    const result = scoreFundamental({
      tokenomics: { circulatingSupply: 100, totalSupply: 95, maxSupply: 100, unlockEvents: [] },
    })
    expect(result.score).toBe(80)
    expect(result.signals).toContainEqual(
      expect.objectContaining({ name: "Supply mostly unlocked", type: "bullish" })
    )
  })

  it("scores low unlocked supply ratio (<= 0.5) as bearish (-30)", () => {
    const result = scoreFundamental({
      tokenomics: { circulatingSupply: 30, totalSupply: 30, maxSupply: 100, unlockEvents: [] },
    })
    expect(result.score).toBe(20)
  })

  it("treats uncomputable supply ratio as missing data (score 0)", () => {
    const result = scoreFundamental({
      tokenomics: { circulatingSupply: 100, totalSupply: null, maxSupply: 100, unlockEvents: [] },
    })
    expect(result.score).toBe(0)
    expect(result.signals[0].name).toBe("insufficient data")
  })

  it("scores high inflation (> 10%) as bearish (-30)", () => {
    const result = scoreFundamental({
      inflation: { currentRatePercent: 15, nextRateChangeDate: null, nextRatePercent: null, historical: [] },
    })
    expect(result.score).toBe(20)
  })

  it("scores deflation (< 0%) as bullish (+30)", () => {
    const result = scoreFundamental({
      inflation: { currentRatePercent: -2, nextRateChangeDate: null, nextRatePercent: null, historical: [] },
    })
    expect(result.score).toBe(80)
  })

  it("scores active development (commits > 50/4w) as bullish (+20)", () => {
    const result = scoreFundamental({
      devActivity: { forks: 10, stars: 500, subscribers: 50, totalIssues: 5, closedIssues: 3, pullRequestsMerged: 20, commitCount4Weeks: 100 },
    })
    expect(result.score).toBe(70)
  })

  it("scores deep discount to ATH (< -70%) as bullish (+20)", () => {
    const result = scoreFundamental({
      ath: { athUsd: 100, athChangePercent: -80, athDate: "2021-01-01" },
    })
    expect(result.score).toBe(70)
  })

  it("scores near ATH (> -10%) as bearish (-20)", () => {
    const result = scoreFundamental({
      ath: { athUsd: 100, athChangePercent: -5, athDate: "2021-01-01" },
    })
    expect(result.score).toBe(30)
  })

  it("clamps all-bullish fundamental data to 100", () => {
    const result = scoreFundamental({
      tokenomics: { circulatingSupply: 100, totalSupply: 95, maxSupply: 100, unlockEvents: [] },
      inflation: { currentRatePercent: -2, nextRateChangeDate: null, nextRatePercent: null, historical: [] },
      devActivity: { forks: 10, stars: 500, subscribers: 50, totalIssues: 5, closedIssues: 3, pullRequestsMerged: 20, commitCount4Weeks: 100 },
      ath: { athUsd: 100, athChangePercent: -80, athDate: "2021-01-01" },
    })
    expect(result.score).toBe(100)
  })

  it("clamps all-bearish fundamental data to 0", () => {
    const result = scoreFundamental({
      tokenomics: { circulatingSupply: 30, totalSupply: 30, maxSupply: 100, unlockEvents: [] },
      inflation: { currentRatePercent: 15, nextRateChangeDate: null, nextRatePercent: null, historical: [] },
      ath: { athUsd: 100, athChangePercent: -5, athDate: "2021-01-01" },
    })
    expect(result.score).toBe(0)
  })
})
