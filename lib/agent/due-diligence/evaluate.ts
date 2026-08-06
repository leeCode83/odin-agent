/**
 * @file due-diligence/evaluate.ts
 * @description Structured evaluation of subagent results for the Main Agent's EVALUATE step.
 *   Decides whether to ACCEPT, RE-DEPLOY, PARTIAL, or FAILED based on confidence thresholds.
 *   Cross-validation contradictions are carried as findings, not as a RE-DEPLOY trigger.
 * @module due-diligence
 * @layer service
 */

import type { FactorReport, CrossValidation } from "@/lib/agent/due-diligence/types"

/**
 * @typedef {"ACCEPT" | "RE-DEPLOY" | "PARTIAL" | "FAILED"} EvalDecision
 * @description Evaluation decision for a set of factor reports.
 *   - ACCEPT: sufficient high-confidence factors, no contradictions.
 *   - RE-DEPLOY: low-confidence factors or contradictions detected.
 *   - PARTIAL: mixed results that don't meet other criteria.
 *   - FAILED: too many factors failed entirely.
 */
export type EvalDecision = "ACCEPT" | "RE-DEPLOY" | "PARTIAL" | "FAILED"

/**
 * @interface EvalResult
 * @description The outcome of evaluating a set of factor reports.
 */
export interface EvalResult {
  decision: EvalDecision
  lowConfidenceFactors: string[]
  contradictions: string[]
  message: string
}

/**
 * @function evaluateResults
 * @description Evaluates subagent factor reports and returns a structured decision.
 *
 * Decision rules (first match wins):
 *   1. **ACCEPT** — 3+ factors with confidence >= 60. Contradictions do NOT block
 *      acceptance: they are legitimate market findings (e.g. bearish technicals vs
 *      bullish fundamentals) and re-running with identical market data regenerates
 *      them — contradiction-based RE-DEPLOY caused loop exhaustion.
 *   2. **FAILED** — 3+ factors failed entirely (score === null).
 *   3. **RE-DEPLOY** — 1-2 low-confidence (<60) or 1-2 failed factors worth one retry.
 *   4. **PARTIAL** — everything else (mixed results).
 *
 * @param {FactorReport[]} factorReports - Array of reports from subagent runs.
 * @param {CrossValidation} [crossValidation] - Optional cross-validation results with contradiction info.
 * @returns {EvalResult} The evaluation decision, low-confidence factors, contradictions, and a human-readable message.
 */
export function evaluateResults(
  factorReports: FactorReport[],
  crossValidation?: CrossValidation
): EvalResult {
  const activeReports = factorReports.filter((r) => r.score !== null)
  const highConfidence = activeReports.filter((r) => (r.confidence ?? 0) >= 60)
  const lowConfidence = activeReports.filter((r) => (r.confidence ?? 0) < 60)
  const failed = factorReports.filter((r) => r.score === null)
  const contradictions = crossValidation?.contradictions ?? []

  // >=3 factors confidence >= 60 → ACCEPT
  // reason: contradictions no longer force RE-DEPLOY — identical market data
  // between iterations regenerates the same contradictions, burning maxLoops.
  if (highConfidence.length >= 3) {
    return {
      decision: "ACCEPT",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions,
      message: contradictions.length > 0
        ? `All clear: ${highConfidence.length}/${activeReports.length} factors high confidence. ${contradictions.length} contradiction(s) documented as findings.`
        : `All clear: ${highConfidence.length}/${activeReports.length} factors high confidence.`,
    }
  }

  // >=3 factors fail → FAILED
  if (failed.length >= 3) {
    return {
      decision: "FAILED",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions,
      message: `${failed.length}/${factorReports.length} factors failed entirely.`,
    }
  }

  // 1-2 factors low confidence OR failed → RE-DEPLOY (one retry round)
  if (lowConfidence.length >= 1 && lowConfidence.length <= 2) {
    return {
      decision: "RE-DEPLOY",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions,
      message: `${lowConfidence.length} factor(s) below confidence 60. Re-deploying...`,
    }
  }

  // Everything else → PARTIAL
  return {
    decision: "PARTIAL",
    lowConfidenceFactors: lowConfidence.map((r) => r.factor),
    contradictions,
    message: `Mixed results: ${highConfidence.length} high, ${lowConfidence.length} low, ${failed.length} failed.`,
  }
}
