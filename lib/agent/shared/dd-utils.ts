/**
 * @file shared/dd-utils.ts
 * @description Shared due-diligence helpers extracted from planning subagent
 *   and pipeline code. Deduplicates degraded-factor extraction and signal
 *   normalization so all callers share one canonical implementation.
 * @module shared/dd-utils
 * @layer service
 */

import type { SignalEntry } from "@/lib/agent/due-diligence/types"

/**
 * @function extractDegradedFactors
 * @description Identifies factor reports whose score is null or missing (not a
 *   number). Accepts either an array of factor reports or a record keyed by
 *   factor name — both shapes exist across planning callers.
 * @param {Array<{factor?: string, score: number|null|undefined}> | Record<string, {factor?: string, score: number|null|undefined} | null>} factorReports
 *   The factor reports to inspect.
 * @returns {string[]} Names of degraded factors (empty when all scores are valid).
 */
export function extractDegradedFactors(
  factorReports:
    | Array<{ factor?: string; score: number | null | undefined }>
    | Record<string, { factor?: string; score: number | null | undefined } | null>,
): string[] {
  if (Array.isArray(factorReports)) {
    return factorReports
      .filter((f) => f.score === null || typeof f.score !== "number")
      .map((f) => f.factor)
      .filter((f): f is string => f !== undefined)
  }
  return Object.values(factorReports)
    .filter((f) => f === null || f.score === null || typeof f.score !== "number")
    .map((f) => (f === null ? undefined : f.factor))
    .filter((f): f is string => f !== undefined)
}

/**
 * @function normalizeSignal
 * @description Converts a raw parsed signal (string or partial object) to a
 *   fully populated SignalEntry with sensible defaults.
 * @param {string | {name?: string, strength?: number, direction?: "bullish"|"bearish"|"neutral"}} signal
 *   The raw signal from LLM output.
 * @returns {SignalEntry} A normalized signal entry with all fields populated.
 */
export function normalizeSignal(
  signal: string | { name?: string; strength?: number; direction?: "bullish" | "bearish" | "neutral" },
): SignalEntry {
  if (typeof signal === "string") {
    return { name: signal, strength: 50, direction: "neutral" }
  }
  return {
    name: signal.name ?? "unknown",
    strength: signal.strength ?? 50,
    direction: signal.direction ?? "neutral",
  }
}
