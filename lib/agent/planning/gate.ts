import type { AutonomyDecision, RiskThresholds } from "@/lib/agent/types"

export function autonomyGate(
  confidence: number,
  positionSizeUsdc: number,
  thresholds: RiskThresholds,
): AutonomyDecision {
  if (confidence >= thresholds.confidenceThreshold && positionSizeUsdc <= thresholds.maxPositionUsdc) {
    return "auto"
  }
  return "approve"
}
