/**
 * @file agent/shared/risk-flags.ts
 * @description Structured risk flags emitted by deterministic planning tools.
 * Replaces fragile substring matching on free-form LLM risk_flags prose: tools
 * return exact enum values and evaluate.ts gates on enum membership only. LLM
 * free-text (risk_flags_text) stays narrative and is never used for gating
 * (spec P4 SA2 PHASE 0 CONTRACT).
 * @module agent/shared/risk-flags
 * @layer agent
 */

import { z } from "zod"

/**
 * @constant RISK_FLAG_VALUES
 * @description Exact contract string values of the RiskFlag enum (P4 SA2
 *   PHASE 0 CONTRACT). Order is canonical display order.
 */
export const RISK_FLAG_VALUES = [
  "funding_overheated",
  "oi_divergence",
  "liquidation_zone_proximity",
  "cascade_risk",
  "low_liquidity",
  "insufficient_data",
] as const

/**
 * @constant RiskFlagSchema
 * @description Zod enum schema validating the RiskFlag set. The single
 *   source of truth for what counts as a structured flag.
 */
export const RiskFlagSchema = z.enum(RISK_FLAG_VALUES)

/**
 * @type RiskFlag
 * @description A structured risk-flag value emitted by a deterministic tool.
 */
export type RiskFlag = z.infer<typeof RiskFlagSchema>

/**
 * @constant RiskFlag
 * @description Value map enabling enum-style access (RiskFlag.funding_overheated),
 *   so callers never hand-write the magic strings.
 */
export const RiskFlag = RISK_FLAG_VALUES.reduce(
  (acc, value) => ({ ...acc, [value]: value }),
  {} as Record<RiskFlag, RiskFlag>
)

/**
 * @function mergeRiskFlags
 * @description Merges per-report risk-flag arrays into a single deduplicated
 *   RiskFlag[] in first-seen order. Non-enum entries (LLM prose, verifier
 *   prefixes) are dropped — only deterministic enum values survive the merge,
 *   so downstream gating never sees free text.
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} flagGroups - One array of
 *   flags per report (e.g. reports.map((r) => r.risk_flags)).
 * @returns {RiskFlag[]} Deduplicated enum flags in first-seen order.
 */
export function mergeRiskFlags(
  flagGroups: ReadonlyArray<ReadonlyArray<unknown>>
): RiskFlag[] {
  const seen = new Set<RiskFlag>()
  const merged: RiskFlag[] = []
  for (const group of flagGroups) {
    for (const flag of group) {
      const parsed = RiskFlagSchema.safeParse(flag)
      if (parsed.success && !seen.has(parsed.data)) {
        seen.add(parsed.data)
        merged.push(parsed.data)
      }
    }
  }
  return merged
}
