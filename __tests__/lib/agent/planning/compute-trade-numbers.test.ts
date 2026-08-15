/**
 * @file __tests__/lib/agent/planning/compute-trade-numbers.test.ts
 * @description Unit tests for computeTradeNumbers — the single deterministic
 *   source of truth for money numbers (entry/SL/TP/position size/leverage).
 *   Every number must come from tool results or the risk engine; anything
 *   missing/invalid forces no_trade with a reason, never a fallback number.
 */

import { describe, it, expect } from "vitest"
import { computeTradeNumbers } from "@/lib/agent/planning/compute-trade-numbers"
import type { ComputeTradeNumbersParams } from "@/lib/agent/planning/compute-trade-numbers"

/**
 * @function validParams
 * @description Builds a fully-valid computeTradeNumbers input; individual tests
 *   override one field to probe a single failure mode.
 * @param {Partial<ComputeTradeNumbersParams>} [overrides] - Field overrides.
 * @returns {ComputeTradeNumbersParams} Valid params (unless overridden).
 */
function validParams(overrides: Partial<ComputeTradeNumbersParams> = {}): ComputeTradeNumbersParams {
  return {
    markPrice: 100,
    atr: 1,
    sltpResult: { stopLoss: 98.5, takeProfit: 103 },
    positionSizeResult: { positionSizeUsdc: 500 },
    thresholds: { max_leverage: 10 },
    equity: 1000,
    side: "long",
    confidence: 0.5,
    ...overrides,
  }
}

describe("computeTradeNumbers", () => {
  it("returns deterministic numbers for a valid long trade", () => {
    const result = computeTradeNumbers(validParams())

    expect(result).toEqual({
      entry: 100,
      stopLoss: 98.5,
      takeProfit: 103,
      positionSizeUsdc: 500,
      leverage: 3.1,
    })
  })

  it("keeps short SL above entry and TP below entry from the sltp result", () => {
    const result = computeTradeNumbers(
      validParams({ side: "short", sltpResult: { stopLoss: 102, takeProfit: 97 } })
    )

    expect(result).toMatchObject({ entry: 100, stopLoss: 102, takeProfit: 97 })
  })

  it("computes leverage from ATR + confidence via computeLeverage", () => {
    expect(computeTradeNumbers(validParams({ atr: 1, confidence: 0.5 }))).toMatchObject({ leverage: 3.1 })
    expect(computeTradeNumbers(validParams({ atr: 0.5, confidence: 0 }))).toMatchObject({ leverage: 2.5 })
  })

  it("does not cap an oversized position size (no new caps)", () => {
    const result = computeTradeNumbers(
      validParams({ positionSizeResult: { positionSizeUsdc: 500000 } })
    )

    expect(result).toMatchObject({ positionSizeUsdc: 500000 })
  })

  it("rounds all output numbers to 2 decimals", () => {
    const result = computeTradeNumbers(
      validParams({
        markPrice: 66000.557,
        sltpResult: { stopLoss: 63000.777, takeProfit: 70000.444 },
        positionSizeResult: { positionSizeUsdc: 2500.666 },
      })
    )

    expect(result).toMatchObject({
      entry: 66000.56,
      stopLoss: 63000.78,
      takeProfit: 70000.44,
      positionSizeUsdc: 2500.67,
    })
  })

  it("returns no_trade when mark price is missing", () => {
    const result = computeTradeNumbers(validParams({ markPrice: undefined }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/mark price/i) })
  })

  it("returns no_trade when mark price is not positive", () => {
    expect(computeTradeNumbers(validParams({ markPrice: 0 }))).toMatchObject({
      no_trade: true,
      reason: expect.stringMatching(/mark price/i),
    })
    expect(computeTradeNumbers(validParams({ markPrice: -5 }))).toMatchObject({ no_trade: true })
  })

  it("returns no_trade when ATR is missing", () => {
    const result = computeTradeNumbers(validParams({ atr: undefined }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/atr/i) })
  })

  it("returns no_trade when ATR is zero", () => {
    const result = computeTradeNumbers(validParams({ atr: 0 }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/atr/i) })
  })

  it("returns no_trade when the compute_sltp result is missing", () => {
    const result = computeTradeNumbers(validParams({ sltpResult: undefined }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/sltp/i) })
  })

  it("returns no_trade when the compute_position_size result is missing", () => {
    const result = computeTradeNumbers(validParams({ positionSizeResult: undefined }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/position size/i) })
  })

  it("returns no_trade when equity is missing, zero, or negative", () => {
    expect(computeTradeNumbers(validParams({ equity: undefined }))).toMatchObject({
      no_trade: true,
      reason: expect.stringMatching(/equity/i),
    })
    expect(computeTradeNumbers(validParams({ equity: 0 }))).toMatchObject({ no_trade: true })
    expect(computeTradeNumbers(validParams({ equity: -100 }))).toMatchObject({ no_trade: true })
  })

  it("returns no_trade when confidence is not a finite number", () => {
    expect(computeTradeNumbers(validParams({ confidence: undefined }))).toMatchObject({
      no_trade: true,
      reason: expect.stringMatching(/confidence/i),
    })
    expect(computeTradeNumbers(validParams({ confidence: Number.NaN }))).toMatchObject({ no_trade: true })
  })

  it("returns no_trade when risk thresholds are missing", () => {
    const result = computeTradeNumbers(validParams({ thresholds: undefined }))

    expect(result).toMatchObject({ no_trade: true, reason: expect.stringMatching(/threshold/i) })
  })

  it("returns no_trade when max_leverage is not positive", () => {
    expect(computeTradeNumbers(validParams({ thresholds: { max_leverage: 0 } }))).toMatchObject({
      no_trade: true,
      reason: expect.stringMatching(/leverage/i),
    })
    expect(computeTradeNumbers(validParams({ thresholds: { max_leverage: -1 } }))).toMatchObject({
      no_trade: true,
    })
  })

  it("returns no_trade when side is invalid", () => {
    expect(computeTradeNumbers(validParams({ side: "no_trade" as never }))).toMatchObject({
      no_trade: true,
      reason: expect.stringMatching(/side/i),
    })
    expect(computeTradeNumbers(validParams({ side: undefined }))).toMatchObject({ no_trade: true })
  })

  it("returns no_trade on NaN inputs", () => {
    expect(computeTradeNumbers(validParams({ markPrice: Number.NaN }))).toMatchObject({ no_trade: true })
    expect(computeTradeNumbers(validParams({ atr: Number.NaN }))).toMatchObject({ no_trade: true })
  })
})
