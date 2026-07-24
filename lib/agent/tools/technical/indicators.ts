/**
 * @file tools/technical/indicators.ts
 * @description 13 ToolDefinitions wrapping technicalindicators npm + manual calculations.
 * Uses a factory pattern to close over a pre-fetched CandleMap.
 * @module tools/technical
 * @layer util
 */

import { z } from "zod"
import type { ToolDefinition, ToolResult } from "@/lib/agent/tools/types"
import type { CandleMap } from "./candles"
import { getTimeframeCandles } from "./candles"
import {
  RSI,
  MACD,
  EMA,
  SMA,
  BollingerBands,
  ATR,
  Stochastic,
  OBV,
  IchimokuCloud,
} from "technicalindicators"

function latencyMs(start: number): number {
  return Date.now() - start
}

function ok(data: unknown, start: number): ToolResult {
  return { success: true, data, metadata: { source: "technicalindicators", latencyMs: latencyMs(start) } }
}

function fail(error: string, start: number): ToolResult {
  return { success: false, error, metadata: { source: "technicalindicators", latencyMs: latencyMs(start) } }
}

const timeframeEnum = z.enum(["1h", "15m", "1d"])

/**
 * @function buildIndicators
 * @description Creates an array of 13 ToolDefinitions that read from a shared CandleMap.
 * @param {CandleMap} candleMap - Pre-fetched candle data keyed by timeframe.
 * @returns {ToolDefinition[]} Array of indicator tool definitions.
 */
export function buildIndicators(candleMap: CandleMap): ToolDefinition[] {
  return [
    createRsiTool(candleMap),
    createMacdTool(candleMap),
    createEmaTool(candleMap),
    createSmaTool(candleMap),
    createBbTool(candleMap),
    createAtrTool(candleMap),
    createStochTool(candleMap),
    createObvTool(candleMap),
    createIchimokuTool(candleMap),
    createVolumeTool(candleMap),
    createSupportResistanceTool(candleMap),
    createFibonacciTool(candleMap),
    createDivergenceTool(candleMap),
  ]
}

function createRsiTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_rsi",
    description: "Relative Strength Index (0-100). Period default 14. Use for overbought (>70) / oversold (<30) / divergence detection.",
    parameters: z.object({ period: z.number().default(14), timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.period + 1) return fail(`Not enough candles for period ${params.period}`, start)
      const closes = candles.map((c) => c.close)
      const values = RSI.calculate({ period: params.period, values: closes })
      return ok(values, start)
    },
  }
}

function createMacdTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_macd",
    description: "Moving Average Convergence Divergence. Fast default 12, slow 26, signal 9. Returns MACD/signal/histogram per bar.",
    parameters: z.object({
      fast: z.number().default(12),
      slow: z.number().default(26),
      signal: z.number().default(9),
      timeframe: timeframeEnum.default("1h"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.slow + 1) return fail(`Not enough candles for slow period ${params.slow}`, start)
      const closes = candles.map((c) => c.close)
      const values = MACD.calculate({
        values: closes,
        fastPeriod: params.fast,
        slowPeriod: params.slow,
        signalPeriod: params.signal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      })
      return ok(values, start)
    },
  }
}

function createEmaTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_ema",
    description: "Exponential Moving Average. Period default 20. Use for trend direction and dynamic support/resistance.",
    parameters: z.object({ period: z.number().default(20), timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.period + 1) return fail(`Not enough candles for period ${params.period}`, start)
      const closes = candles.map((c) => c.close)
      const values = EMA.calculate({ period: params.period, values: closes })
      return ok(values, start)
    },
  }
}

function createSmaTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_sma",
    description: "Simple Moving Average. Period default 20. Use for trend smoothing and crossovers.",
    parameters: z.object({ period: z.number().default(20), timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.period + 1) return fail(`Not enough candles for period ${params.period}`, start)
      const closes = candles.map((c) => c.close)
      const values = SMA.calculate({ period: params.period, values: closes })
      return ok(values, start)
    },
  }
}

function createBbTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_bb",
    description: "Bollinger Bands. Period default 20, stdDev default 2. Returns upper/middle/lower bands.",
    parameters: z.object({
      period: z.number().default(20),
      stddev: z.number().default(2),
      timeframe: timeframeEnum.default("1h"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.period + 1) return fail(`Not enough candles for period ${params.period}`, start)
      const closes = candles.map((c) => c.close)
      const values = BollingerBands.calculate({ period: params.period, stdDev: params.stddev, values: closes })
      return ok(values, start)
    },
  }
}

function createAtrTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_atr",
    description: "Average True Range. Period default 14. Measures market volatility.",
    parameters: z.object({ period: z.number().default(14), timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.period + 1) return fail(`Not enough candles for period ${params.period}`, start)
      const highs = candles.map((c) => c.high)
      const lows = candles.map((c) => c.low)
      const closes = candles.map((c) => c.close)
      const values = ATR.calculate({ high: highs, low: lows, close: closes, period: params.period })
      return ok(values, start)
    },
  }
}

function createStochTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_stoch",
    description: "Stochastic Oscillator %K/%D. K period default 14, D signal period default 3. Overbought >80, oversold <20.",
    parameters: z.object({
      k: z.number().default(14),
      d: z.number().default(3),
      timeframe: timeframeEnum.default("1h"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.k + 1) return fail(`Not enough candles for k period ${params.k}`, start)
      const highs = candles.map((c) => c.high)
      const lows = candles.map((c) => c.low)
      const closes = candles.map((c) => c.close)
      const values = Stochastic.calculate({ high: highs, low: lows, close: closes, period: params.k, signalPeriod: params.d })
      return ok(values, start)
    },
  }
}

function createObvTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_obv",
    description: "On-Balance Volume. Measures volume flow relative to price. Rising OBV confirms uptrend.",
    parameters: z.object({ timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < 2) return fail("Not enough candles for OBV", start)
      const closes = candles.map((c) => c.close)
      const volumes = candles.map((c) => c.volume)
      const values = OBV.calculate({ close: closes, volume: volumes })
      return ok(values, start)
    },
  }
}

function createIchimokuTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_ichimoku",
    description: "Ichimoku Cloud. Tenkan default 9, Kijun default 26, Senkou default 52. Returns conversion/base/spanA/spanB.",
    parameters: z.object({
      tenkan: z.number().default(9),
      kijun: z.number().default(26),
      senkou: z.number().default(52),
      timeframe: timeframeEnum.default("1h"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      const maxPeriod = Math.max(params.tenkan, params.kijun, params.senkou)
      if (candles.length < maxPeriod + 1) return fail(`Not enough candles for period ${maxPeriod}`, start)
      const highs = candles.map((c) => c.high)
      const lows = candles.map((c) => c.low)
      const values = IchimokuCloud.calculate({
        high: highs,
        low: lows,
        conversionPeriod: params.tenkan,
        basePeriod: params.kijun,
        spanPeriod: params.senkou,
        displacement: 26,
      })
      return ok(values, start)
    },
  }
}

function createVolumeTool(_candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_volume",
    description: "Volume analysis: average volume, current volume ratio, and trend direction (increasing/decreasing/neutral).",
    parameters: z.object({ timeframe: timeframeEnum.default("1h") }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, _candleMap)
      if (candles.length < 2) return fail("Not enough candles for volume analysis", start)
      const volumes = candles.map((c) => c.volume)
      const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length
      const currentVolume = volumes[volumes.length - 1]
      const volumeRatio = currentVolume / avgVolume
      const recent = volumes.slice(-5)
      const trend = recent.length >= 2 && recent[recent.length - 1] > recent[0]
        ? "increasing"
        : recent.length >= 2 && recent[recent.length - 1] < recent[0]
          ? "decreasing"
          : "neutral"
      return ok({ avgVolume, currentVolume, volumeRatio, trend }, start)
    },
  }
}

function createSupportResistanceTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_support_resistance",
    description: "Detects swing high/low support and resistance levels from recent price action.",
    parameters: z.object({
      lookback: z.number().default(20),
      timeframe: timeframeEnum.default("1h"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.lookback + 2) return fail(`Not enough candles for lookback ${params.lookback}`, start)
      const half = Math.max(2, Math.floor(params.lookback / 4))
      const highs = candles.map((c) => c.high)
      const lows = candles.map((c) => c.low)
      const support: number[] = []
      const resistance: number[] = []
      for (let i = half; i < candles.length - half; i++) {
        const leftHigh = highs.slice(i - half, i)
        const rightHigh = highs.slice(i + 1, i + 1 + half)
        if (leftHigh.every((h) => highs[i] >= h) && rightHigh.every((h) => highs[i] >= h)) {
          resistance.push(highs[i])
        }
        const leftLow = lows.slice(i - half, i)
        const rightLow = lows.slice(i + 1, i + 1 + half)
        if (leftLow.every((l) => lows[i] <= l) && rightLow.every((l) => lows[i] <= l)) {
          support.push(lows[i])
        }
      }
      return ok({ support, resistance }, start)
    },
  }
}

function createFibonacciTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_fibonacci",
    description: "Fibonacci retracement levels (0.236/0.382/0.5/0.618/0.786) from the most recent swing high and low.",
    parameters: z.object({
      lookback: z.number().default(50),
      timeframe: timeframeEnum.default("1d"),
    }),
    execute: async (params) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.lookback) return fail(`Not enough candles for lookback ${params.lookback}`, start)
      const relevant = candles.slice(-params.lookback)
      const high = Math.max(...relevant.map((c) => c.high))
      const low = Math.min(...relevant.map((c) => c.low))
      const diff = high - low
      return ok({
        high,
        low,
        "level_0.236": high - diff * 0.236,
        "level_0.382": high - diff * 0.382,
        "level_0.5": high - diff * 0.5,
        "level_0.618": high - diff * 0.618,
        "level_0.786": high - diff * 0.786,
      }, start)
    },
  }
}

interface DivergenceParams {
  timeframe: "1h" | "15m" | "1d"
  indicator: "rsi" | "macd"
  period: number
  lookback: number
}

function createDivergenceTool(candleMap: CandleMap): ToolDefinition {
  return {
    name: "get_divergence",
    description: "Detects regular and hidden divergence between price and RSI/MACD. Regular bearish: price makes higher high, indicator makes lower high.",
    parameters: z.object({
      timeframe: timeframeEnum.default("1h"),
      indicator: z.enum(["rsi", "macd"]).default("rsi"),
      period: z.number().default(14),
      lookback: z.number().default(30),
    }),
    execute: async (params: DivergenceParams) => {
      const start = Date.now()
      const candles = getTimeframeCandles(params.timeframe, candleMap)
      if (candles.length < params.lookback + params.period) return fail(`Not enough candles`, start)

      const closes = candles.map((c) => c.close)
      let indicatorValues: number[] = []

      if (params.indicator === "rsi") {
        indicatorValues = RSI.calculate({ period: params.period, values: closes })
      } else {
        const macdResult = MACD.calculate({
          values: closes,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          SimpleMAOscillator: false,
          SimpleMASignal: false,
        })
        indicatorValues = macdResult.map((m) => m.MACD ?? 0)
      }

      const offset = closes.length - indicatorValues.length
      const recentCloses = closes.slice(offset).slice(-params.lookback)
      const recentInd = indicatorValues.slice(-params.lookback)

      const priceHighIdx = recentCloses.indexOf(Math.max(...recentCloses))
      const priceLowIdx = recentCloses.indexOf(Math.min(...recentCloses))
      const indHighIdx = recentInd.indexOf(Math.max(...recentInd))
      const indLowIdx = recentInd.indexOf(Math.min(...recentInd))

      const latestPrice = recentCloses[recentCloses.length - 1]
      const latestInd = recentInd[recentInd.length - 1]
      const prevPriceHigh = recentCloses[priceHighIdx]
      const prevIndHigh = recentInd[indHighIdx]
      const prevPriceLow = recentCloses[priceLowIdx]
      const prevIndLow = recentInd[indLowIdx]

      const regularBearish = latestPrice > prevPriceHigh && latestInd < prevIndHigh
      const regularBullish = latestPrice < prevPriceLow && latestInd > prevIndLow
      const hiddenBearish = latestPrice < prevPriceHigh && latestInd > prevIndHigh
      const hiddenBullish = latestPrice > prevPriceLow && latestInd < prevIndLow

      return ok({ regularBearish, regularBullish, hiddenBearish, hiddenBullish }, start)
    },
  }
}
