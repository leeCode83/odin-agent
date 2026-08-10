/**
 * @file planning/verifier.ts
 * @description Deterministic post-return validation for planning perspective
 *   reports (T13). Pure function — no I/O, no side effects — that reconciles
 *   the LLM's returned trading numbers against the actual tool results
 *   recorded in the ReAct loop history, so the LLM can never guess entry
 *   price, SL/TP, or position size.
 *
 *   Enforcement model:
 *   - Hard: a proposed trade without a successful get_mark_price call is
 *     forced to no_trade with all numeric fields zeroed.
 *   - Override-if-available: entry/SL/TP/size are replaced by the LAST
 *     successful tool result when the tool ran; otherwise LLM values survive.
 * @module planning
 * @layer service
 */

import type { PerspectiveReport } from "@/lib/agent/planning/types"
import type { HistoryEntry } from "@/lib/agent/due-diligence/subagent"

/** @constant {string} ENTRY_FLAG - Risk flag pushed when a trade lacks get_mark_price. */
const ENTRY_FLAG = "verifier: entry_price tanpa get_mark_price"

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
 * @function verifyReportAgainstTools
 * @description Reconciles a perspective report against the tool ledger:
 *
 *   1. `no_trade` side or null score → returned unchanged (nothing to enforce).
 *   2. A trade proposed with NO successful `get_mark_price` call → forced to
 *      `no_trade`, all trading numbers zeroed, risk flag pushed (deduped).
 *   3. `entry_price` more than 0.1% from the last mark price → overridden to
 *      the mark price.
 *   4. Successful `compute_sltp` → `suggested_stop_loss` / `suggested_take_profit`
 *      overridden from `{ stopLoss, takeProfit }` (LLM values kept when absent).
 *   5. Successful `compute_position_size` → `suggested_position_size_usdc`
 *      overridden from `{ positionSizeUsdc }` (LLM value kept when absent).
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
  const markPrice = getNumberField(lastResult["get_mark_price"], "markPrice")

  // reason: hard rule — entry price must come from the market, not the LLM.
  // Without a successful get_mark_price the trade is unverifiable, so the
  // report is demoted to no_trade and every trading number is zeroed.
  if (markPrice === undefined) {
    const flag = ENTRY_FLAG
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

  // reason: override-if-available — a diverging LLM entry is replaced by the
  // mark price; within 0.1% the LLM value is treated as a rounding artifact.
  const entryMismatch = Math.abs(report.entry_price - markPrice) / markPrice
  const entryPrice = entryMismatch > 0.001 ? round2(markPrice) : report.entry_price

  const sltpPayload = lastResult["compute_sltp"]
  const stopLoss = getNumberField(sltpPayload, "stopLoss")
  const takeProfit = getNumberField(sltpPayload, "takeProfit")

  const sizePayload = lastResult["compute_position_size"]
  const positionSizeUsdc = getNumberField(sizePayload, "positionSizeUsdc")

  return {
    ...report,
    entry_price: entryPrice,
    // reason: SL/TP override-if-available — tool results win, LLM values
    // survive only when the tool was never successfully called.
    suggested_stop_loss: stopLoss !== undefined ? round2(stopLoss) : report.suggested_stop_loss,
    suggested_take_profit: takeProfit !== undefined ? round2(takeProfit) : report.suggested_take_profit,
    suggested_position_size_usdc:
      positionSizeUsdc !== undefined ? round2(positionSizeUsdc) : report.suggested_position_size_usdc,
  }
}
