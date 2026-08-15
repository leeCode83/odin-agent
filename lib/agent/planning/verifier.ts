/**
 * @file planning/verifier.ts
 * @description Deterministic post-return guard for planning perspective
 *   reports (T13). Pure function — no I/O, no side effects — that enforces the
 *   tool-required contract against the ReAct loop history: a trade is only
 *   verifiable when get_mark_price, compute_sltp, AND compute_position_size
 *   each produced a successful result. When any required tool did NOT run
 *   successfully the trade is forced to no_trade — LLM-guessed numbers never
 *   survive a skipped tool (no override-if-available fallback).
 *
 *   Enforcement model:
 *   - Hard: a proposed trade without a successful get_mark_price call is
 *     forced to no_trade with all numeric fields zeroed.
 *   - Hard: without a successful compute_sltp call → forced to no_trade.
 *   - Hard: without a successful compute_position_size call → forced to
 *     no_trade.
 *   - When all three tools succeeded, entry/SL/TP/size are ALWAYS taken from
 *     the tool results (entry = last mark price, no 0.1% tolerance).
 * @module planning
 * @layer service
 */

import type { PerspectiveReport } from "@/lib/agent/planning/types"
import type { HistoryEntry } from "@/lib/agent/due-diligence/subagent"

/** @constant {string} ENTRY_FLAG - Risk flag pushed when a trade lacks get_mark_price. */
const ENTRY_FLAG = "verifier: entry_price tanpa get_mark_price"
/** @constant {string} SLTP_FLAG - Risk flag pushed when a trade lacks compute_sltp. */
const SLTP_FLAG = "verifier: SL/TP tanpa compute_sltp"
/** @constant {string} SIZE_FLAG - Risk flag pushed when a trade lacks compute_position_size. */
const SIZE_FLAG = "verifier: position size tanpa compute_position_size"

/**
 * @function round2
 * @description Rounds a number to 2 decimal places so verifier overrides match
 *   the deterministic risk-engine output style.
 * @param {number} n - Value to round.
 * @returns {number} Rounded value.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * @function asRecord
 * @description Coerces an unknown tool payload to a plain object record, or {}
 *   when it is not object-shaped — defensive against tool result drift.
 * @param {unknown} payload - Raw payload from a history entry.
 * @returns {Record<string, unknown>} Object-shaped payload, or {}.
 */
function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * @function getNumberField
 * @description Extracts a numeric field from a tool payload, tolerating both
 *   `payload[key]` and `payload.data[key]` nesting — some tool layers wrap the
 *   result one level deep.
 * @param {unknown} payload - Raw tool payload.
 * @param {string} key - Field name to read.
 * @returns {number | undefined} The numeric value, or undefined when absent/not a number.
 */
function getNumberField(payload: unknown, key: string): number | undefined {
  const record = asRecord(payload)
  const nested = asRecord(record.data)
  const value = record[key] ?? nested[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * @function lastSuccessfulByTool
 * @description Builds a lookup of the LAST successful (`result.success === true`)
 *   call per toolName from the history, preserving the raw payloads. Failed
 *   calls never shadow an earlier success.
 * @param {HistoryEntry[]} history - Full ReAct loop tool ledger.
 * @returns {Record<string, unknown>} toolName → last successful payload.
 */
function lastSuccessfulByTool(history: HistoryEntry[]): Record<string, unknown> {
  const lookup: Record<string, unknown> = {}
  for (const entry of history) {
    if (entry.result.success) lookup[entry.toolName] = entry.result.data
  }
  return lookup
}

/**
 * @function forceNoTrade
 * @description Demotes a report to no_trade, zeroes every trading number, and
 *   pushes a risk flag (deduped). Pure — returns a new report object.
 * @param {PerspectiveReport} report - Report to demote.
 * @param {string} flag - Verifier risk flag naming the missing required tool.
 * @returns {PerspectiveReport} Forced no_trade report.
 */
function forceNoTrade(report: PerspectiveReport, flag: string): PerspectiveReport {
  return {
    ...report,
    side: "no_trade",
    entry_price: 0,
    suggested_stop_loss: 0,
    suggested_take_profit: 0,
    suggested_position_size_usdc: 0,
    // reason: dedupe — the flag may already exist from a previous verifier pass.
    risk_flags: report.risk_flags.includes(flag) ? report.risk_flags : [...report.risk_flags, flag],
  }
}

/**
 * @function verifyReportAgainstTools
 * @description Guards a perspective report against the tool ledger:
 *
 *   1. `no_trade` side or null score → returned unchanged (nothing to enforce).
 *   2. A trade proposed with NO successful `get_mark_price` call → forced to
 *      `no_trade`, all trading numbers zeroed, ENTRY_FLAG pushed (deduped).
 *   3. No successful `compute_sltp` call → forced to `no_trade` (SLTP_FLAG).
 *   4. No successful `compute_position_size` call → forced to `no_trade`
 *      (SIZE_FLAG).
 *   5. All three required tools succeeded → entry is set to the last mark
 *      price, SL/TP from the last `compute_sltp` result, size from the last
 *      `compute_position_size` result (no 0.1% tolerance — the mark price is
 *      always authoritative).
 *
 *   Pure: returns a new report object; input report and history are never mutated.
 * @param {PerspectiveReport} report - Merged perspective report from runPerspectiveSubagent.
 * @param {HistoryEntry[]} toolHistory - ReAct loop tool ledger ([] when the
 *   subagent never surfaced one, e.g. score-null force returns).
 * @returns {PerspectiveReport} Verified report with deterministic trading numbers.
 */
export function verifyReportAgainstTools(
  report: PerspectiveReport,
  toolHistory: HistoryEntry[]
): PerspectiveReport {
  // reason: no_trade has nothing to enforce, and a null score means the
  // analysis never completed — touching either would fabricate a decision.
  if (report.side === "no_trade" || report.score === null) return report

  const lastResult = lastSuccessfulByTool(toolHistory)

  // reason: hard rule — entry price must come from the market, not the LLM.
  // Without a successful get_mark_price the trade is unverifiable.
  const markPrice = getNumberField(lastResult["get_mark_price"], "markPrice")
  if (markPrice === undefined) return forceNoTrade(report, ENTRY_FLAG)

  // reason: hard rule — SL/TP must come from compute_sltp (ATR-based tool
  // output). A trade whose stop levels were never computed cannot be sized or
  // risked, so the LLM's numbers are not allowed to survive.
  const sltpPayload = lastResult["compute_sltp"]
  const stopLoss = getNumberField(sltpPayload, "stopLoss")
  const takeProfit = getNumberField(sltpPayload, "takeProfit")
  if (stopLoss === undefined || takeProfit === undefined) return forceNoTrade(report, SLTP_FLAG)

  // reason: hard rule — position size must come from compute_position_size.
  const sizePayload = lastResult["compute_position_size"]
  const positionSizeUsdc = getNumberField(sizePayload, "positionSizeUsdc")
  if (positionSizeUsdc === undefined) return forceNoTrade(report, SIZE_FLAG)

  return {
    ...report,
    // reason: entry is always the mark price (rounded) — the LLM's entry is
    // ignored entirely; the old 0.1% tolerance let LLM numbers survive.
    entry_price: round2(markPrice),
    suggested_stop_loss: round2(stopLoss),
    suggested_take_profit: round2(takeProfit),
    suggested_position_size_usdc: round2(positionSizeUsdc),
  }
}
