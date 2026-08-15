import type { AutonomyDecision, RiskThresholds } from "@/lib/agent/types"
import type { DeterministicConfidenceResult } from "@/lib/agent/shared/deterministic-confidence"

/**
 * @function autonomyGate
 * @description Determines whether a trade should be executed automatically or requires human approval based on confidence and position size.
 * @param {number | DeterministicConfidenceResult} confidence - The confidence score (plain number, or the deterministic confidence object whose `score` is read — never an LLM-produced value).
 * @param {number} positionSizeUsdc - The proposed position size in USDC.
 * @param {RiskThresholds} thresholds - The user's risk thresholds.
 * @returns {AutonomyDecision} "auto" if within thresholds, otherwise "approve".
 */
export function autonomyGate(
  confidence: number | DeterministicConfidenceResult,
  positionSizeUsdc: number,
  thresholds: RiskThresholds,
): AutonomyDecision {
  const score = typeof confidence === "number" ? confidence : confidence.score
  if (score >= thresholds.confidence_threshold && positionSizeUsdc <= thresholds.max_position_usdc) {
    return "auto"
  }
  return "approve"
}
