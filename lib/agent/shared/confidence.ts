/**
 * @file Deterministic confidence computation from agent execution signals.
 *
 * Confidence is derived purely from observable execution behavior (tool call
 * outcomes, data coverage, loop exit reason) instead of the subagent's
 * verbalized self-assessment. Deterministic, reproducible, and uniform across
 * all factor subagents.
 *
 * @example
 * computeDeterministicConfidence({
 *   totalToolCalls: 5,
 *   successToolCalls: 5,
 *   uniqueTools: 3,
 *   emptyDataCalls: 0,
 *   transientErrors: 0,
 *   permanentErrors: 0,
 *   stopReason: 'llm_return',
 * }); // => 100
 */

export type StopReason = 'llm_return' | 'max_loops' | 'timeout' | 'circuit_open' | 'duplicate';

export interface ExecutionSignals {
  totalToolCalls: number;
  successToolCalls: number;
  uniqueTools: number;
  emptyDataCalls: number;
  transientErrors: number;
  permanentErrors: number;
  stopReason?: StopReason;
}

const PERMANENT_ERROR_PENALTY = 20;
const TRANSIENT_ERROR_PENALTY = 5;
const EMPTY_DATA_PENALTY = 10;
const LOW_COVERAGE_PENALTY = 15;
const MIN_UNIQUE_TOOLS = 2;
const MIN_CONFIDENCE = 15;
const MAX_CONFIDENCE = 100;

const STOP_REASON_PENALTY: Record<StopReason, number> = {
  llm_return: 0,
  max_loops: 10,
  timeout: 30,
  circuit_open: 40,
  duplicate: 50,
};

/**
 * Computes a deterministic confidence score (0-100) from execution signals.
 *
 * Starts at 100 and subtracts penalties for errors, empty tool data, low tool
 * coverage, and abnormal loop termination. Clamped to [15, 100]: a factor that
 * ran at all stays above zero so it can still trigger a low-confidence
 * RE-DEPLOY instead of being silently treated as failed.
 *
 * @param signals - Observed execution behavior of one subagent run.
 * @returns Confidence score clamped to [15, 100].
 */
export function computeDeterministicConfidence(signals: ExecutionSignals): number {
  if (signals.totalToolCalls === 0) return MIN_CONFIDENCE;

  const stopPenalty = signals.stopReason
    ? STOP_REASON_PENALTY[signals.stopReason]
    : 0;

  const confidence =
    MAX_CONFIDENCE -
    signals.permanentErrors * PERMANENT_ERROR_PENALTY -
    signals.transientErrors * TRANSIENT_ERROR_PENALTY -
    signals.emptyDataCalls * EMPTY_DATA_PENALTY -
    (signals.uniqueTools < MIN_UNIQUE_TOOLS ? LOW_COVERAGE_PENALTY : 0) -
    stopPenalty;

  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, confidence));
}
