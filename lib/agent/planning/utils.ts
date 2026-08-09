/**
 * @file lib/agent/planning/utils.ts
 * @description Helper utilities for the Planning Agent module — DDReport compaction & prompt token optimization.
 * @module agent/planning
 * @layer service
 */

import type { DDReport } from "@/lib/agent/types"

/**
 * @interface CompactCrossValidation
 * @description Compacted cross-validation without verbose pairwise notes.
 */
export interface CompactCrossValidation {
  overallAlignment: number
  contradictions: string[]
}

/**
 * @interface CompactDDReport
 * @description Pruned version of DDReport optimized for LLM prompt context windows.
 *   Removes verbose subagent reasoning logs (`factorReports`), pairwise comparison notes,
 *   and execution telemetry while retaining 100% of trading-critical signals, thesis, risks, and catalysts.
 */
export interface CompactDDReport {
  asset: string
  timestamp: string
  sections: DDReport["sections"]
  aggregated_thesis?: string
  confidence_score?: number
  overallScore?: number
  overallConfidence?: number
  risk_flags: string[]
  risks?: DDReport["risks"]
  catalysts?: DDReport["catalysts"]
  summary?: string
  crossValidation?: CompactCrossValidation
  /**
   * @property {Object} [factorCoverage] - Optional factor coverage summary consumed by downstream planning
   *   agents to detect partial/failed due diligence.
   *   `plannedFactors` lists every key of `sections`, INCLUDING failed factors whose score is null.
   *   `usableCount` counts only sections where `typeof score === "number"`.
   *   Omitted entirely when `sections` is absent or empty (cleaner contract; consumers fall back
   *   to a default when the field is missing).
   */
  factorCoverage?: { plannedFactors: string[]; usableCount: number }
}

/**
 * @function compactDDReport
 * @description Prunes verbose reasoning logs, pairwise comparisons, and execution metadata
 *   from a DDReport to minimize token consumption in Planning Agent prompts.
 * @param {DDReport} report - Full DDReport produced by the Due Diligence Agent.
 * @returns {CompactDDReport} Compacted report payload safe for prompt inclusion.
 */
export function compactDDReport(report: DDReport): CompactDDReport {
  const {
    asset,
    timestamp,
    sections,
    aggregated_thesis,
    confidence_score,
    overallScore,
    overallConfidence,
    risk_flags,
    risks,
    catalysts,
    summary,
    crossValidation,
  } = report

  const compactCrossValidation: CompactCrossValidation | undefined = crossValidation
    ? {
        overallAlignment: crossValidation.overallAlignment,
        contradictions: crossValidation.contradictions,
      }
    : undefined

  // reason: derive coverage from sections so failed (null-score) factors stay
  // visible to planning; omitted when sections is absent/empty.
  const compactFactorCoverage =
    sections && Object.keys(sections).length > 0
      ? {
          plannedFactors: Object.keys(sections),
          usableCount: Object.values(sections).filter(
            (s) => s !== undefined && typeof s.score === "number"
          ).length,
        }
      : undefined

  return {
    asset,
    timestamp,
    sections,
    ...(aggregated_thesis !== undefined && { aggregated_thesis }),
    ...(confidence_score !== undefined && { confidence_score }),
    ...(overallScore !== undefined && { overallScore }),
    ...(overallConfidence !== undefined && { overallConfidence }),
    risk_flags,
    ...(risks !== undefined && { risks }),
    ...(catalysts !== undefined && { catalysts }),
    ...(summary !== undefined && { summary }),
    ...(compactCrossValidation !== undefined && { crossValidation: compactCrossValidation }),
    ...(compactFactorCoverage !== undefined && { factorCoverage: compactFactorCoverage }),
  }
}
