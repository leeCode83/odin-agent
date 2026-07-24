/**
 * @file due-diligence/evaluate.ts
 * @description Structured evaluation of subagent results for the Main Agent's EVALUATE step.
 *   Decides whether to ACCEPT, RE-DEPLOY, PARTIAL, or FAILED based on confidence thresholds
 *   and cross-validation contradictions.
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
 *   1. **ACCEPT** — 3+ factors with confidence >= 60 AND no contradictions in cross-validation.
 *   2. **FAILED** — 3+ factors failed entirely (score === null).
 *   3. **RE-DEPLOY** — 1-2 factors with confidence < 60.
 *   4. **RE-DEPLOY** — contradictions found in cross-validation.
 *   5. **PARTIAL** — everything else (mixed results).
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

  // >=3 factors confidence >= 60, no contradictions → ACCEPT
  if (highConfidence.length >= 3 && (!crossValidation || crossValidation.contradictions.length === 0)) {
    return {
      decision: "ACCEPT",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions: crossValidation?.contradictions ?? [],
      message: `All clear: ${highConfidence.length}/${activeReports.length} factors high confidence.`,
    }
  }

  // >=3 factors fail → FAILED
  if (failed.length >= 3) {
    return {
      decision: "FAILED",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions: crossValidation?.contradictions ?? [],
      message: `${failed.length}/${factorReports.length} factors failed entirely.`,
    }
  }

  // 1-2 factors low confidence → RE-DEPLOY
  if (lowConfidence.length >= 1 && lowConfidence.length <= 2) {
    return {
      decision: "RE-DEPLOY",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions: crossValidation?.contradictions ?? [],
      message: `${lowConfidence.length} factor(s) below confidence 60. Re-deploying...`,
    }
  }

  // Contradictions found → RE-DEPLOY cross-verify
  if (crossValidation && crossValidation.contradictions.length > 0) {
    return {
      decision: "RE-DEPLOY",
      lowConfidenceFactors: lowConfidence.map((r) => r.factor),
      contradictions: crossValidation.contradictions,
      message: `Contradictions detected: ${crossValidation.contradictions.join("; ")}. Re-deploying for cross-verification.`,
    }
  }

  // Everything else → PARTIAL
  return {
    decision: "PARTIAL",
    lowConfidenceFactors: lowConfidence.map((r) => r.factor),
    contradictions: crossValidation?.contradictions ?? [],
    message: `Mixed results: ${highConfidence.length} high, ${lowConfidence.length} low, ${failed.length} failed.`,
  }
}
