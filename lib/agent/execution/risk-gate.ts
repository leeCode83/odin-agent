/**
 * @file execution/risk-gate.ts
 * @description Deterministic execution-time risk verification (defense-in-depth
 *   second layer after planning). Pure validation — no I/O, no order logic.
 * @module execution
 * @layer service
 */

import { computePositionSize } from "@/lib/agent/shared/risk-engine"
import type { RiskThresholds, TradePlan } from "@/lib/agent/types"

/**
 * @interface AccountRiskState
 * @description Optional live account state fed into the risk gate. Callers
 *   fetch this (e.g. from clearinghouse state) and pass it in — the gate
 *   itself never touches the network.
 * @property {number} [equityUsdc] - Account equity (withdrawable) in USDC.
 *   Absent → check 3 is skipped, never fail-closed.
 * @property {number} [assetMaxLeverage] - Per-asset isolated-margin max
 *   leverage cap from exchange metadata. Absent → thresholds.max_leverage is
 *   the only cap.
 */
export interface AccountRiskState {
  equityUsdc?: number
  assetMaxLeverage?: number
}

/**
 * @typedef RiskGateResult
 * @description Result of the risk gate.
 */
export type RiskGateResult = { ok: true } | { ok: false; reasons: string[] }

/**
 * @function verifyTradePlanAgainstRisk
 * @description Deterministic execution-time risk gate (defense-in-depth — a
 *   second gate after planning, never an LLM input). Validates a TradePlan
 *   against user risk thresholds and optional live account state before any
 *   order reaches the exchange. Pure: callers fetch thresholds and account
 *   state and pass them in, so the gate is fully unit-testable.
 *
 *   Checks (all deterministic):
 *   1. Leverage cap — plan.leverage must be > 0 and <= min(thresholds
 *      .max_leverage, accountState.assetMaxLeverage when present).
 *   2. Stop inside the liquidation cushion — Hyperliquid isolated-margin
 *      mechanics: tier-1 maintenance margin ≈ half of initial margin at max
 *      leverage (mmr = 0.5/L), so liq ≈ entry×(1−0.5/L) for longs and
 *      entry×(1+0.5/L) for shorts; cushion distance ≈ 0.5/L. Require the
 *      plan's own SL to sit inside the cushion with 20% headroom: longs SL
 *      must be above entry×(1−0.5/L×0.8), shorts SL below
 *      entry×(1+0.5/L×0.8). E.g. L=10 → cushion 5%, headroom line 4% — an
 *      SL 4.5% from entry violates. Leverage 1 passes trivially (cushion
 *      huge).
 *   3. Position size vs equity risk — recompute allowed size with
 *      computePositionSize(equity, entry, SL, risk_per_trade_percent); plan
 *      size above allowed × 1.05 (5% rounding tolerance) violates. Skipped
 *      when equity is unavailable (don't fail-closed on data we cannot get).
 *
 *   NO_TRADE sentinel plans (action NO_TRADE, or leverage <= 1 with zero
 *   size) pass trivially — nothing is placed.
 * @param {TradePlan} plan - The validated trade plan about to be placed.
 * @param {object} options - Gate inputs.
 * @param {RiskThresholds} options.thresholds - User risk thresholds.
 * @param {AccountRiskState} [options.accountState] - Optional live account
 *   state (equity, per-asset max leverage).
 * @returns {RiskGateResult} ok=false reports every violated check in
 *   `reasons` (all violations at once, not first-fail).
 */
export function verifyTradePlanAgainstRisk(
  plan: TradePlan,
  options: { thresholds: RiskThresholds; accountState?: AccountRiskState }
): RiskGateResult {
  const { thresholds } = options
  const accountState = options.accountState ?? {}
  const reasons: string[] = []

  if (plan.action === "NO_TRADE" || (plan.leverage <= 1 && plan.position_size_usdc === 0)) {
    return { ok: true }
  }

  const leverageCap = Math.min(
    thresholds.max_leverage,
    accountState.assetMaxLeverage ?? Number.POSITIVE_INFINITY
  )
  if (plan.leverage <= 0) {
    reasons.push(`leverage=${plan.leverage} must be positive`)
  } else if (plan.leverage > leverageCap) {
    reasons.push(`leverage=${plan.leverage} exceeds cap ${leverageCap}`)
  }

  if (plan.leverage > 0) {
    const headroom = (0.5 / plan.leverage) * 0.8
    if (plan.side === "long") {
      const line = plan.entry_price * (1 - headroom)
      if (plan.stop_loss <= line) {
        reasons.push(`stop_loss=${plan.stop_loss} sits at/below liquidation-cushion headroom line ${line} for leverage=${plan.leverage}`)
      }
    } else {
      const line = plan.entry_price * (1 + headroom)
      if (plan.stop_loss >= line) {
        reasons.push(`stop_loss=${plan.stop_loss} sits at/above liquidation-cushion headroom line ${line} for leverage=${plan.leverage}`)
      }
    }
  }

  const equity = accountState.equityUsdc
  if (equity !== undefined && equity > 0) {
    const allowed = computePositionSize(
      equity,
      plan.entry_price,
      plan.stop_loss,
      thresholds.risk_per_trade_percent
    )
    if (plan.position_size_usdc > allowed.positionSizeUsdc * 1.05) {
      reasons.push(`position_size_usdc=${plan.position_size_usdc} exceeds risk-budget size ${allowed.positionSizeUsdc} (equity=${equity}, risk=${thresholds.risk_per_trade_percent}%)`)
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
