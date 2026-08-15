/**
 * @file __tests__/lib/agent/planning/verifier.test.ts
 * @description Unit tests for verifyReportAgainstTools — the deterministic
 *   post-return GUARD for planning perspective reports. Required tools
 *   (get_mark_price, compute_sltp, compute_position_size) must all have
 *   produced a successful result; if any did not, the trade is forced to
 *   no_trade. LLM values never survive a skipped tool.
 */

import { describe, it, expect } from "vitest"
import { verifyReportAgainstTools } from "@/lib/agent/planning/verifier"
import type { PerspectiveReport } from "@/lib/agent/planning/types"
import type { HistoryEntry } from "@/lib/agent/due-diligence/subagent"

/** @function makeReport - Builds a full PerspectiveReport fixture. */
function makeReport(overrides: Partial<PerspectiveReport> = {}): PerspectiveReport {
  return {
    perspective: "conservative",
    score: 70,
    confidence: 80,
    side: "long",
    entry_price: 65000,
    signals: [{ name: "ATR reasonable", strength: 70, direction: "bullish" }],
    dataSources: ["hyperliquid"],
    reasoning: "Validated against live market data",
    iterations: 3,
    conclusion: "Go long",
    errors: [],
    suggested_stop_loss: 62000,
    suggested_take_profit: 71000,
    suggested_position_size_usdc: 1000,
    risk_flags: ["Funding positive"],
    ...overrides,
  }
}

/** @function makeHistory - Builds a HistoryEntry fixture. */
function makeHistory(
  toolName: string,
  data: unknown,
  overrides: Partial<HistoryEntry["result"]> = {}
): HistoryEntry {
  return {
    toolName,
    result: {
      success: true,
      metadata: { source: "hyperliquid", latencyMs: 10 },
      data,
      ...overrides,
    },
  }
}

/** @function verifierFlags - Filters verifier-pushed risk flags. */
function verifierFlags(report: PerspectiveReport): string[] {
  return report.risk_flags.filter((f) => f.startsWith("verifier:"))
}

describe("verifyReportAgainstTools", () => {
  it("forces no_trade + risk flag when a trade is proposed without get_mark_price", () => {
    const history = [makeHistory("compute_atr", { atr: 2.5 })]
    const result = verifyReportAgainstTools(makeReport(), history)

    expect(result.side).toBe("no_trade")
    expect(result.entry_price).toBe(0)
    expect(result.suggested_stop_loss).toBe(0)
    expect(result.suggested_take_profit).toBe(0)
    expect(result.suggested_position_size_usdc).toBe(0)
    expect(result.risk_flags).toContain("verifier: entry_price tanpa get_mark_price")
  })

  it("does not dedupe the risk flag when absent", () => {
    const result = verifyReportAgainstTools(makeReport({ risk_flags: [] }), [])
    expect(verifierFlags(result)).toHaveLength(1)
  })

  it("dedupes the risk flag when already present", () => {
    const report = makeReport({ risk_flags: ["verifier: entry_price tanpa get_mark_price"] })
    const result = verifyReportAgainstTools(report, [])
    expect(verifierFlags(result)).toHaveLength(1)
  })

  it("overrides entry_price to the mark price (LLM entry never survives)", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 66000 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 2500 }),
    ]
    const result = verifyReportAgainstTools(makeReport({ entry_price: 65000 }), history)

    expect(result.side).toBe("long")
    expect(result.entry_price).toBe(66000)
  })

  it("uses the mark price even when the LLM entry is within 0.1% (no tolerance)", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65060 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 2500 }),
    ]
    const result = verifyReportAgainstTools(makeReport({ entry_price: 65000 }), history)

    expect(result.side).toBe("long")
    expect(result.entry_price).toBe(65060)
  })

  it("overrides SL/TP from a successful compute_sltp call", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65000 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 2500 }),
    ]
    const result = verifyReportAgainstTools(
      makeReport({ suggested_stop_loss: 62000, suggested_take_profit: 71000 }),
      history
    )

    expect(result.suggested_stop_loss).toBe(63000)
    expect(result.suggested_take_profit).toBe(70000)
  })

  it("forces no_trade when get_mark_price ran but compute_sltp was never called", () => {
    const history = [makeHistory("get_mark_price", { markPrice: 65000 })]
    const result = verifyReportAgainstTools(
      makeReport({ suggested_stop_loss: 62000, suggested_take_profit: 71000 }),
      history
    )

    expect(result.side).toBe("no_trade")
    expect(result.entry_price).toBe(0)
    expect(result.suggested_stop_loss).toBe(0)
    expect(result.suggested_take_profit).toBe(0)
    expect(result.suggested_position_size_usdc).toBe(0)
    expect(result.risk_flags).toContain("verifier: SL/TP tanpa compute_sltp")
  })

  it("overrides position size from a successful compute_position_size call", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65000 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 2500, positionSizeContracts: 0.038 }),
    ]
    const result = verifyReportAgainstTools(makeReport({ suggested_position_size_usdc: 1000 }), history)

    expect(result.suggested_position_size_usdc).toBe(2500)
  })

  it("forces no_trade when compute_position_size was never called", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65000 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
    ]
    const result = verifyReportAgainstTools(makeReport({ suggested_position_size_usdc: 1000 }), history)

    expect(result.side).toBe("no_trade")
    expect(result.entry_price).toBe(0)
    expect(result.suggested_stop_loss).toBe(0)
    expect(result.suggested_take_profit).toBe(0)
    expect(result.suggested_position_size_usdc).toBe(0)
    expect(result.risk_flags).toContain("verifier: position size tanpa compute_position_size")
  })

  it("uses the LAST successful call per tool when the tool ran multiple times", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65000 }),
      makeHistory("get_mark_price", { markPrice: 66000 }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }),
      makeHistory("compute_sltp", { stopLoss: 64000, takeProfit: 69000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 1000 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 3000 }),
    ]
    const result = verifyReportAgainstTools(
      makeReport({ entry_price: 60000, suggested_stop_loss: 1, suggested_take_profit: 2, suggested_position_size_usdc: 3 }),
      history
    )

    expect(result.entry_price).toBe(66000)
    expect(result.suggested_stop_loss).toBe(64000)
    expect(result.suggested_take_profit).toBe(69000)
    expect(result.suggested_position_size_usdc).toBe(3000)
  })

  it("ignores failed tool calls when building the lookup", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 65000 }, { success: false, error: "API down" }),
      makeHistory("compute_sltp", { stopLoss: 63000, takeProfit: 70000 }, { success: false, error: "bad" }),
    ]
    const result = verifyReportAgainstTools(
      makeReport({ suggested_stop_loss: 62000, suggested_take_profit: 71000 }),
      history
    )

    expect(result.side).toBe("no_trade")
    expect(result.risk_flags).toContain("verifier: entry_price tanpa get_mark_price")
    expect(result.suggested_stop_loss).toBe(0)
    expect(result.suggested_take_profit).toBe(0)
  })

  it("returns the report unchanged when side is no_trade", () => {
    const report = makeReport({ side: "no_trade", entry_price: 0, suggested_stop_loss: 0 })
    const result = verifyReportAgainstTools(report, [])

    expect(result).toEqual(report)
  })

  it("returns the report unchanged when score is null", () => {
    const report = makeReport({ score: null, confidence: null, entry_price: 0 })
    const result = verifyReportAgainstTools(report, [])

    expect(result).toEqual(report)
  })

  it("does not mutate the input report or history", () => {
    const report = makeReport({ entry_price: 60000 })
    const history = [makeHistory("get_mark_price", { markPrice: 66000 })]
    const snapshotReport = { ...report, risk_flags: [...report.risk_flags] }
    const snapshotHistory = JSON.parse(JSON.stringify(history))

    verifyReportAgainstTools(report, history)

    expect(report).toEqual(snapshotReport)
    expect(history).toEqual(snapshotHistory)
  })

  it("rounds overridden numbers to 2 decimals", () => {
    const history = [
      makeHistory("get_mark_price", { markPrice: 66000.557 }),
      makeHistory("compute_sltp", { stopLoss: 63000.777, takeProfit: 70000.444 }),
      makeHistory("compute_position_size", { positionSizeUsdc: 2500.666 }),
    ]
    const result = verifyReportAgainstTools(makeReport({ entry_price: 60000 }), history)

    expect(result.entry_price).toBe(66000.56)
    expect(result.suggested_stop_loss).toBe(63000.78)
    expect(result.suggested_take_profit).toBe(70000.44)
    expect(result.suggested_position_size_usdc).toBe(2500.67)
  })
})
