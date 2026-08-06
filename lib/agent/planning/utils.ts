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
  category: string
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
    category,
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

  return {
    asset,
    category,
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
  }
}
