/**
 * @file planning/agent.ts
 * @description Main planning swarm orchestrator. Runs the Plan-Execute-Reflect
 *   loop (spec §6.2): auto-calls the DD agent, deploys the three perspective
 *   subagents, aggregates their reports via LLM, and evaluates consensus
 *   (Layer 1, spec §8.1). On ACCEPT it applies the autonomy gate (Layer 2,
 *   spec §8.2) and builds the final TradePlan. Mirrors the runDDAgent() loop
 *   structure (see lib/agent/due-diligence/agent.ts:149-288).
 * @module planning/agent
 * @layer agent
 */

import { plan, rePlan, aggregate } from "@/lib/agent/planning/llm"
import { runPerspectiveSubagent } from "@/lib/agent/planning/subagent"
import { buildPlanningToolRegistry } from "@/lib/agent/planning/tools"
import { evaluateConsensus } from "@/lib/agent/planning/evaluate"
import { autonomyGate } from "@/lib/agent/planning/gate"
import { computeATR, computeLeverage, computePositionSize } from "@/lib/agent/shared/risk-engine"
import { recordDecision } from "@/lib/db/graph-memory"
import { extractDegradedFactors } from "@/lib/agent/shared/dd-utils"
import { getRiskThresholds, envDefaults } from "@/lib/db/risk-thresholds"
import { fetchUserEquity, fetchCandlesForATR } from "@/lib/data/hyperliquid"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import { TradePlanSchema } from "@/lib/agent/types"
import { log } from "@/lib/agent/planning/log"
import type { AutonomyDecision, RiskThresholds, TradePlan } from "@/lib/agent/types"
import type {
  PlanningAgentInput,
  PlanningAgentOutput,
  PlanningAggregationResult,
  PlanningSubagentPlan,
  Perspective,
  PerspectiveReport,
  ConsensusResult,
} from "@/lib/agent/planning/types"

/**
 * @constant MAX_LOOPS
 * @description Maximum Plan-Execute-Reflect iterations (spec §6.2, fail fast: was 5).
 */
const MAX_LOOPS = 3

/**
 * @constant PLANNING_LOOP_TIMEOUT_MS
 * @description Wall-clock budget for the planning loop; each iteration start
 *   checks the deadline and breaks with a partial best-effort plan (fail fast).
 *   Overridable via PLANNING_LOOP_TIMEOUT_MS (testability knob, not documented).
 */
const PLANNING_LOOP_TIMEOUT_MS = 300_000

/**
 * @constant MAX_RE_DEPLOYS_PER_PERSPECTIVE
 * @description Re-deploy cap per perspective before forced acceptance
 * (spec §8.1 last row — "Re-deployed 2x for same perspective").
 */
const MAX_RE_DEPLOYS_PER_PERSPECTIVE = 2

/**
 * @constant PERSPECTIVES
 * @description The three trading perspectives the swarm always deploys.
 */
const PERSPECTIVES: Perspective[] = ["conservative", "balance", "aggressive"]

/**
 * @function fallbackPlan
 * @description Fallback PLAN output: deploys all three perspectives with a
 *   generic instruction. Used when the PLAN/rePLAN LLM call returns empty.
 * @param {string} asset - Asset ticker.
 * @returns {PlanningSubagentPlan[]} Plans for all three perspectives.
 */
function fallbackPlan(asset: string): PlanningSubagentPlan[] {
  return PERSPECTIVES.map((perspective, i) => ({
    perspective,
    instruction: `Analyze ${asset} from the ${perspective} perspective and produce a trade plan with appropriate risk discipline`,
    priority: i + 1,
  }))
}

/**
 * @function median
 * @description Median of a number array (middle value of the sorted copy).
 * @param {number[]} values - Input values.
 * @returns {number} Median, or 0 for an empty array.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * @function fallbackAggregation
 * @description Deterministic merge fallback (spec §9.2) used when the
 *   AGGREGATE LLM call never succeeded but a plan must still be built
 *   (forced accept / loop exhausted). Majority vote for side, medians for
 *   prices/confidence, no profit feasibility.
 * @param {PerspectiveReport[]} reports - Accumulated perspective reports.
 * @returns {PlanningAggregationResult} Synthesized aggregation.
 */
function fallbackAggregation(reports: PerspectiveReport[]): PlanningAggregationResult {
  // Guard: no reports → cannot compute meaningful prices, force NO_TRADE
  if (reports.length === 0) {
    return {
      side: "no_trade",
      thesis: "No subagent data — planning timed out before reports were available",
      reasoning: "Planning loop exhausted before any perspective subagent completed",
      confidence_score: 0,
      confidence_breakdown: { factor_alignment: 0, historical_match: 0, signal_strength: 0 },
      risk_flags: ["planning_timeout", "no_subagent_data"],
      consensus_alignment: 0,
      contradictions: [],
      profit_feasible: false,
      no_trade_reason: "Planning timed out — no subagent reports available",
      entry_price: 0,
      stop_loss: 0,
      take_profit: 0,
      position_size_usdc: 0,
    }
  }

  const longs = reports.filter((r) => r.side === "long")
  const shorts = reports.filter((r) => r.side === "short")
  // ponytail: confidence-weighted tie-break — equal counts go to higher
  // avg confidence; still tied → default long (schema forces a side).
  const longAvg = longs.length
    ? longs.reduce((s, r) => s + (r.confidence ?? 0), 0) / longs.length
    : 0
  const shortAvg = shorts.length
    ? shorts.reduce((s, r) => s + (r.confidence ?? 0), 0) / shorts.length
    : 0
  return {
    // reason: no_trade is never chosen here — NO_TRADE is decided by
    // evaluateConsensus from the reports themselves, not by this fallback.
    side: longs.length > shorts.length || (longs.length === shorts.length && longAvg >= shortAvg)
      ? "long"
      : "short",
    thesis: "Best-effort plan from perspective reports (aggregation failed)",
    reasoning:
      reports.map((r) => `${r.perspective}: ${r.reasoning}`).join("; ") ||
      "No perspective reasoning available",
    confidence_score: Math.round(median(reports.map((r) => r.confidence ?? 0))),
    // reason: reports carry no confidence_breakdown — zeros mark it as unmeasured.
    confidence_breakdown: { factor_alignment: 0, historical_match: 0, signal_strength: 0 },
    risk_flags: Array.from(new Set(reports.flatMap((r) => r.risk_flags))),
    consensus_alignment: 0,
    contradictions: [],
    profit_feasible: false,
    entry_price: median(reports.map((r) => r.entry_price)),
    stop_loss: median(reports.map((r) => r.suggested_stop_loss)),
    take_profit: median(reports.map((r) => r.suggested_take_profit)),
    position_size_usdc: 0,
  }
}

/**
 * @interface BuildTradePlanParams
 * @description Parameters for building the final TradePlan.
 */
interface BuildTradePlanParams {
  asset: string
  aggregation: PlanningAggregationResult
  equity: number
  thresholds: RiskThresholds
  autonomyDecision: AutonomyDecision
  iterations: number
  totalMs: number
}

/**
 * @function buildTradePlan
 * @description Assembles the final TradePlan from the accepted aggregation.
 *   NO_TRADE encodes a zero-size placeholder position: SL = entry*0.99,
 *   TP = entry*1.01, position_size_usdc 0, leverage 1 (spec §8.1 row 8).
 *   Leverage is the risk engine's deterministic OUTPUT (never LLM input):
 *   ATR is fetched once from Hyperliquid (same source as the compute_atr
 *   tool) and fed to computeLeverage. Any ATR fetch failure degrades to
 *   leverage 1 (conservative) instead of crashing the plan.
 * @param {BuildTradePlanParams} params - Plan assembly inputs.
 * @returns {Promise<TradePlan>} Zod-validated trade plan.
 */
async function buildTradePlan(params: BuildTradePlanParams): Promise<TradePlan> {
  const { asset, aggregation, equity, thresholds, autonomyDecision, iterations, totalMs } = params

  // Guard: invalid prices for a live trade → force NO_TRADE
  const hasInvalidPrices =
    aggregation.side !== "no_trade" &&
    (aggregation.entry_price <= 0 ||
      aggregation.stop_loss <= 0 ||
      aggregation.take_profit <= 0)

  const safeAggregation: PlanningAggregationResult = hasInvalidPrices
    ? {
        ...aggregation,
        side: "no_trade",
        no_trade_reason: "Invalid price data (zero or negative values) — forcing NO_TRADE",
        risk_flags: [...aggregation.risk_flags, "invalid_price_data"],
      }
    : aggregation

  const noTrade = safeAggregation.side === "no_trade"
  const action = noTrade ? "NO_TRADE" : safeAggregation.side === "short" ? "SHORT" : "LONG"
  // reason: schema requires a positive entry — a NO_TRADE with no market
  // reference uses placeholder 1 so SL/TP stay schema-valid.
  const entry = safeAggregation.entry_price > 0 ? safeAggregation.entry_price : 1
  const stopLoss = noTrade ? entry * 0.99 : safeAggregation.stop_loss
  const takeProfit = noTrade ? entry * 1.01 : safeAggregation.take_profit
  const { positionSizeContracts } = computePositionSize(
    equity,
    entry,
    stopLoss,
    thresholds.risk_per_trade_percent
  )

  // reason: leverage is the risk engine's OUTPUT — never LLM input. ATR is
  // fetched once (1h window, same source as the compute_atr tool); a fetch
  // or ATR failure degrades to leverage 1 (conservative), never a crash.
  let atr = 0
  if (!noTrade) {
    try {
      const candles = await fetchCandlesForATR(asset, "1h", 20)
      atr = computeATR(candles, 14)
    } catch (err) {
      log("warn", "planning.atr_failed", {
        asset,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const leverage =
    noTrade || atr <= 0
      ? 1
      : computeLeverage({
          entry,
          atr,
          // reason: aggregation confidence is 0-100; computeLeverage expects 0-1.
          confidence: safeAggregation.confidence_score / 100,
          maxLeverage: thresholds.max_leverage,
          volTarget: Number(process.env.RISK_VOL_TARGET) || 0.05,
        })

  return TradePlanSchema.parse({
    asset,
    // reason: TradePlanSchema.side only allows long|short — NO_TRADE falls
    // back to "long" (the position is zero-sized, side is decorative).
    side: noTrade ? "long" : safeAggregation.side,
    action,
    entry_price: entry,
    position_size_usdc: noTrade ? 0 : safeAggregation.position_size_usdc,
    position_size_contracts: noTrade ? 0 : positionSizeContracts,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    leverage,
    confidence_score: safeAggregation.confidence_score,
    confidence_breakdown: safeAggregation.confidence_breakdown,
    thesis: safeAggregation.thesis,
    reasoning: safeAggregation.reasoning,
    autonomy_decision: autonomyDecision,
    risk_flags: safeAggregation.risk_flags,
    graph_patterns_used: [],
    consensus_alignment: safeAggregation.consensus_alignment,
    processingTimeMs: totalMs,
    iterations,
    timestamp: new Date().toISOString(),
  })
}

/**
 * @function persistDecision
 * @description Non-blocking persistence of an accepted decision to the graph
 *   database. Failures are logged, never fatal (mirrors the DD agent's
 *   recordDDReport pattern, agent.ts:228-234).
 * @param {TradePlan} plan - The accepted trade plan.
 * @param {PlanningAgentInput} params - Run input (user/wallet context).
 * @returns {void}
 */
function persistDecision(
  plan: TradePlan,
  params: PlanningAgentInput,
  outcome?: "accepted" | "forced" | "no_trade"
): void {
  const isNoTrade = plan.action === "NO_TRADE" || outcome === "no_trade"
  recordDecision({
    userId: params.userId,
    asset: plan.asset,
    category: "trade",
    decision: isNoTrade ? "hold" : plan.side === "long" ? "buy" : "sell",
    side: isNoTrade ? "no_trade" : plan.side,
    confidence: plan.confidence_score,
    tradePlan: plan,
    autonomyDecision: plan.autonomy_decision,
    timestamp: new Date().toISOString(),
  } as unknown as Parameters<typeof recordDecision>[0]).catch((e) =>
    console.warn("[PlanningAgent] Failed to persist decision:", e)
  )
}

/**
 * @function runPlanningAgent
 * @description Main planning swarm orchestrator (spec §6.2). Assumes a valid
 *   DD report is provided via input. Pre-fetches equity once (spec §16.4), then
 *   runs up to 3 Plan-Execute-Reflect iterations (fail fast: a loop deadline
 *   checked at each iteration start breaks out with a partial best-effort
 *   plan):
 *   1. PLAN — llm plan (first iteration) or rePlan (low-consensus only).
 *   2. EXECUTE — all planned perspective subagents in parallel, sharing one
 *      tool registry bound to the pre-fetched equity.
 *   3. AGGREGATE — llm aggregation; null keeps the previous result.
 *   4. EVALUATE — deterministic consensus (Layer 1).
 *   ACCEPT breaks to Layer 2 (autonomy gate) and builds the TradePlan.
 *   NO_TRADE builds a zero-size placeholder plan. FAILED throws
 *   PlanningError. RE-DEPLOY loops until the per-perspective cap (2) forces
 *   acceptance of the best available data. Loop exhaustion returns a partial
 *   best-effort plan.
 * @param {PlanningAgentInput} params - Input parameters (asset, user, profit target).
 * @returns {Promise<PlanningAgentOutput>} Trade plan, timings, status.
 * @throws {PlanningError} Unknown asset, DD failure, or all-subagent failure.
 */
export async function runPlanningAgent(params: PlanningAgentInput): Promise<PlanningAgentOutput> {
  const t0 = Date.now()
  const errors: string[] = []
  const timing = { planMs: 0, executeMs: 0, aggregateMs: 0, evaluateMs: 0 }

  log("info", "planning.started", { asset: params.asset, userId: params.userId })

  // --- Step 0: equity pre-fetch ---
  const { ddReport } = params

  // --- Step 0b: DD report quality gate (user-requested) ---
  // reason: a "successful" DD run can still return a broken report (all factor
  // sections null-scored, or status failed). Planning on garbage input wastes
  // minutes of LLM calls and always ends in a meaningless NO_TRADE, so break
  // out early — the route maps category "dd" to recordDDFailure() and the
  // circuit breaker rejects subsequent requests for the cooldown window.
  // Graceful degradation rule: ONLY status "failed" or zero usable factors is
  // fatal. A "partial" report with usable factors continues — confidence is
  // penalized later (multiplier = usable/planned, see below) so degraded
  // input flows to the approval path instead of a 500.
  const usableFactorCount =
    ddReport.usableFactorCount ??
    Object.values(ddReport.sections ?? {}).filter((s) => typeof s.score === "number").length
  // reason: the sections record holds every factor DD intentionally deployed —
  // including failed ones (score null) — so plannedFactorCount is the penalty
  // denominator. A deliberately small DD (2 factors, all successful) must not
  // be discounted against a fixed 4; fall back to usableFactorCount when no
  // sections are recorded (avoids division by zero downstream).
  const plannedFactorCount = Object.keys(ddReport.sections ?? {}).length || usableFactorCount
  if (ddReport.status === "failed" || usableFactorCount === 0) {
    throw new PlanningError(
      "PLANNING_FAILED",
      {
        phase: "dd",
        reports: [],
        aggregation: null,
        ddReport,
        message:
          ddReport.status === "failed"
            ? `DD report status is failed (usable factor scores: ${usableFactorCount})`
            : `DD report has 0 usable factor scores out of ${plannedFactorCount} deployed sections (status: ${ddReport.status ?? "unknown"}) — a partial report with at least one usable factor proceeds with a confidence penalty instead of failing`,
      },
      Date.now() - t0,
      "dd"
    )
  }

  // reason: degraded-DD signaling (F3) — same factor-failure derivation as the
  // pipeline's ddCoverage; passed to evaluateConsensus so NO_TRADE reasons get
  // the failed-factors suffix and RE-DEPLOY messages get the "[degraded DD]"
  // label (retry-for-data vs retry-for-consensus).
  const degradedFactors = extractDegradedFactors(ddReport.factorReports ?? [])

  // reason: equity is pre-fetched once (spec §16.4) — no get_equity tool —
  // and shared through the tool registry ctx + position sizing.
  const equity = await fetchUserEquity(params.walletAddress).catch(() => 0)

  let allReports: PerspectiveReport[] = []
  let aggregation: PlanningAggregationResult | null = null
  const reDeployCounts: Record<string, number> = {}
  let lastLowConsensus: string[] = []

  let outcome: "accepted" | "forced" | "no_trade" | "exhausted" = "exhausted"
  // reason: transparency (2c) — keep the final consensus evaluation around for
  // the output (per-perspective breakdown + no-trade rule detail). evaluation
  // is loop-scoped, so mirror the last one here.
  let latestConsensus: ConsensusResult | null = null
  // reason: loop exhausts only when RE-DEPLOY keeps coming back with an empty
  // low-consensus set (aggregation failure with fully aligned reports) — the
  // per-perspective cap otherwise forces acceptance by iteration 2.
  let finalIterations = MAX_LOOPS

  for (let iteration = 0; iteration < MAX_LOOPS; iteration++) {
    // reason: fail fast — break out of the loop once the planning budget is
    // exhausted; the shared tail builds a partial best-effort plan.
    if (Date.now() - t0 > (Number(process.env.PLANNING_LOOP_TIMEOUT_MS) || PLANNING_LOOP_TIMEOUT_MS)) {
      log("warn", "planning.timeout", { iteration, elapsedMs: Date.now() - t0 })
      finalIterations = iteration
      break
    }

    // --- PLAN ---
    const planT0 = Date.now()
    let subagentPlans: PlanningSubagentPlan[]
    if (iteration === 0) {
      const planned = await plan({
        ddReport,
        targetProfitPercent: params.targetProfitPercent,
      })
      subagentPlans = planned.length > 0 ? planned : fallbackPlan(params.asset)
    } else {
      const replanned = await rePlan({
        ddReport,
        targetProfitPercent: params.targetProfitPercent,
        lowConsensusPerspectives: lastLowConsensus,
        previousReports: allReports.filter((r) => lastLowConsensus.includes(r.perspective)),
      })
      subagentPlans =
        replanned.length > 0
          ? replanned
          : lastLowConsensus.map((p) => ({
              perspective: p as Perspective,
              instruction: `Re-analyze ${params.asset} from the ${p} perspective with higher scrutiny`,
              priority: 1,
            }))
    }
    timing.planMs += Date.now() - planT0

    // --- EXECUTE ---
    const execT0 = Date.now()
    const tools = buildPlanningToolRegistry({
      walletAddress: params.walletAddress,
      userId: params.userId,
      asset: params.asset,
      equity,
    })
    const newReports = await Promise.all(
      subagentPlans.map((sp) =>
        runPerspectiveSubagent({
          perspective: sp.perspective,
          instruction: sp.instruction,
          asset: params.asset,
          ddReport,
          targetProfitPercent: params.targetProfitPercent,
          tools,
        })
      )
    )
    timing.executeMs += Date.now() - execT0

    // Map-dedupe by perspective — latest report per perspective wins, so
    // evaluateConsensus always sees the freshest 3 reports.
    allReports = Array.from(
      new Map([...allReports, ...newReports].map((r) => [r.perspective, r])).values()
    )

    // --- AGGREGATE ---
    const aggT0 = Date.now()
    const agg = await aggregate({
      reports: allReports,
      ddReport,
      targetProfitPercent: params.targetProfitPercent,
    })
    if (agg) {
      aggregation = agg
    } else {
      errors.push(`Aggregation step returned null on iteration ${iteration + 1}`)
      // reason: keep the previous aggregation as fallback context, but force
      // profit_feasible false so stale feasibility never satisfies the ACCEPT rules.
      // (typed intermediate avoids TS2698 on spreading an Omit-intersection
      // into a `T | null` assignment target)
      if (aggregation) {
        const kept: PlanningAggregationResult = { ...aggregation, profit_feasible: false }
        aggregation = kept
      }
    }
    timing.aggregateMs += Date.now() - aggT0

    // --- EVALUATE (Layer 1) ---
    const evalT0 = Date.now()
    const evaluation = evaluateConsensus(
      allReports,
      aggregation,
      degradedFactors.length > 0 ? degradedFactors : undefined
    )
    timing.evaluateMs += Date.now() - evalT0
    latestConsensus = evaluation
    log("info", "consensus.evaluated", {
      iteration,
      decision: evaluation.decision,
      message: evaluation.message,
      perspectiveBreakdown: evaluation.perspectiveBreakdown,
      noTradeReasonDetail: evaluation.noTradeReasonDetail,
    })

    if (evaluation.decision === "ACCEPT") {
      outcome = "accepted"
      finalIterations = iteration + 1
      break
    }
    if (evaluation.decision === "NO_TRADE") {
      outcome = "no_trade"
      finalIterations = iteration + 1
      log("info", "planning.no_trade", { reason: evaluation.noTradeReason ?? evaluation.message })
      break
    }
    if (evaluation.decision === "FAILED") {
      throw new PlanningError(
        "PLANNING_FAILED",
        { phase: "evaluate", reports: allReports, aggregation, ddReport },
        Date.now() - t0
      )
    }

    // RE-DEPLOY — count per perspective; cap forces acceptance of best
    // available data (spec §8.1 last row).
    for (const p of evaluation.lowConsensusPerspectives) {
      reDeployCounts[p] = (reDeployCounts[p] ?? 0) + 1
    }
    log("warn", "planning.redeploy", {
      perspectives: evaluation.lowConsensusPerspectives,
      iteration,
    })
    if (
      evaluation.lowConsensusPerspectives.some(
        (p) => reDeployCounts[p] >= MAX_RE_DEPLOYS_PER_PERSPECTIVE
      )
    ) {
      outcome = "forced"
      finalIterations = iteration + 1
      break
    }
    lastLowConsensus = evaluation.lowConsensusPerspectives
  }

  const totalMs = Date.now() - t0

  if (outcome === "exhausted" && allReports.length === 0) {
    log("warn", "planning.no_trade_forced", {
      reason: "no_subagent_reports_after_timeout",
      elapsedMs: totalMs,
    })
    outcome = "no_trade"
  }

  // --- Layer 2 (ACCEPT / forced / exhausted paths) ---
  // reason: NO_TRADE skips the gate — nothing is at risk; a zero-size
  // position would trivially satisfy it anyway, so "auto" is forced.
  const thresholds = await getRiskThresholds(params.userId).catch(() => envDefaults())
  // reason: confidence penalty (graceful degradation of partial DD, spec
  // §9.x). A report with usable < planned factors discounts the swarm's
  // confidence BEFORE the autonomy gate, so degraded input flows to the human
  // approval path instead of failing. Formula:
  //   multiplier = usableFactorCount / plannedFactorCount
  // plannedFactorCount = number of sections deployed by DD (incl. failed ones
  // with null score); usableFactorCount = sections with a numeric score.
  // All deployed factors succeeded → 1.0 (no penalty, no fixed 4); penalty
  // applies only when some deployed factors failed (3/4 → 0.75, 2/4 → 0.5).
  const ddConfidenceMultiplier = Math.min(1, usableFactorCount / plannedFactorCount)
  const finalAggregation = aggregation ?? fallbackAggregation(allReports)
  const effectiveAggregation: PlanningAggregationResult =
    ddConfidenceMultiplier < 1
      ? {
          ...finalAggregation,
          confidence_score: Math.round(finalAggregation.confidence_score * ddConfidenceMultiplier),
        }
      : finalAggregation
  const autonomyDecision: AutonomyDecision =
    outcome === "no_trade"
      ? "auto"
      : autonomyGate(
          effectiveAggregation.confidence_score,
          effectiveAggregation.position_size_usdc,
          thresholds
        )

  const tradePlan = await buildTradePlan({
    asset: params.asset,
    aggregation: effectiveAggregation,
    equity,
    thresholds,
    autonomyDecision,
    iterations: finalIterations,
    totalMs,
  })

  // reason: approval_required = penalized (partial DD) run that still needs
  // human approval — distinct from "partial" (loop exhaustion) and from
  // complete runs that happen to carry autonomy_decision "approve".
  const status: PlanningAgentOutput["status"] =
    tradePlan.action === "NO_TRADE" || outcome === "no_trade"
      ? "no_trade"
      : ddConfidenceMultiplier < 1 && autonomyDecision === "approve"
        ? "approval_required"
        : outcome === "accepted"
          ? "complete"
          : "partial"

  if (outcome === "accepted" || outcome === "forced" || outcome === "no_trade") {
    persistDecision(tradePlan, params, outcome)
  }

  log("info", "planning.completed", { asset: params.asset, status, outcome })

  return {
    report: tradePlan,
    timing: { ...timing, totalMs },
    iterations: finalIterations,
    status,
    // reason: spread keeps the key ABSENT when consensus never ran (dd-gate
    // failure path throws earlier) — same omit-when-absent contract as ddCoverage.
    ...(latestConsensus
      ? {
          consensus: {
            perspectiveBreakdown: latestConsensus.perspectiveBreakdown,
            noTradeReasonDetail: latestConsensus.noTradeReasonDetail,
          },
        }
      : {}),
  }
}
