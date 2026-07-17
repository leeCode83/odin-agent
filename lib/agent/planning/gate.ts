import type { AutonomyDecision, RiskThresholds } from "@/lib/agent/types"

/**
 * @function autonomyGate
 * @description Determines whether a trade should be executed automatically or requires human approval based on confidence and position size.
 * @param {number} confidence - The computed confidence score of the trade plan.
 * @param {number} positionSizeUsdc - The proposed position size in USDC.
 * @param {RiskThresholds} thresholds - The user's risk thresholds.
 * @returns {AutonomyDecision} "auto" if within thresholds, otherwise "approve".
 */
export function autonomyGate(
  confidence: number,
  positionSizeUsdc: number,
  thresholds: RiskThresholds,
): AutonomyDecision {
  if (confidence >= thresholds.confidence_threshold && positionSizeUsdc <= thresholds.max_position_usdc) {
    return "auto"
  }
  return "approve"
}
