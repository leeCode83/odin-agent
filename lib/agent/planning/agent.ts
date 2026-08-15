/**
 * @file planning/agent.ts
 * @description Main planning swarm orchestrator. Runs the Plan-Execute-Reflect
 *   loop (spec §6.2): auto-calls the DD agent, deploys the three perspective
 *   subagents, aggregates their reports via LLM, and evaluates consensus
 *   (Layer 1, spec §8.1). On ACCEPT it applies the autonomy gate (Layer 2,
 *   spec §8.2) and builds the final TradePlan.
 *
 *   Deterministic integration (Fase 2): the PLAN/RE-PLAN step is deterministic
 *   (buildFixedPerspectives), every money number (entry/SL/TP/size/leverage/
 *   confidence) is computed in code — never from the LLM. The LLM supplies only
 *   narrative (side/thesis/reasoning/contradictions); computeTradeNumbers is
 *   the single source of trade numbers and deterministicConfidence the single
 *   source of confidence, both fed from tool results and the DD report.
 *
 *   Mirrors the runDDAgent() loop structure (see lib/agent/due-diligence/agent.ts:149-288).
 * @module planning/agent
 * @layer agent
 */

import { aggregate } from "@/lib/agent/planning/llm"
import { buildFixedPerspectives } from "@/lib/agent/planning/fixed-planner"
import { runPerspectiveSubagent } from "@/lib/agent/planning/subagent"
import { buildPlanningToolRegistry } from "@/lib/agent/planning/tools"
import { evaluateConsensus } from "@/lib/agent/planning/evaluate"
import { autonomyGate } from "@/lib/agent/planning/gate"
import {
  computeATR,
  computeLeverage,
  computePositionSize,
  computeSLTP,
} from "@/lib/agent/shared/risk-engine"
import { recordDecision, queryPerspectivePerformance, queryGraphPatterns } from "@/lib/db/graph-memory"
import {
  computePerspectiveWeights,
  applyWta,
  DEFAULT_WEIGHT_CONFIG,
} from "@/lib/agent/planning/consensus/weights"
import { extractDegradedFactors } from "@/lib/agent/shared/dd-utils"
import { getRiskThresholds, envDefaults } from "@/lib/db/risk-thresholds"
import { fetchUserEquity, fetchCandlesForATR, fetchMarkPrice } from "@/lib/data/hyperliquid"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import { TradePlanSchema } from "@/lib/agent/types"
import { computeTradeNumbers } from "@/lib/agent/planning/compute-trade-numbers"
import { deterministicConfidence } from "@/lib/agent/shared/deterministic-confidence"
import type {
  DeterministicConfidenceResult,
  FactorScoreInput,
  HistoricalMatchInput,
} from "@/lib/agent/shared/deterministic-confidence"
import { mergeRiskFlags } from "@/lib/agent/shared/risk-flags"
import { computeProfitFeasibility } from "@/lib/agent/shared/feasibility"
import { log } from "@/lib/agent/planning/log"
import type { AutonomyDecision, RiskThresholds, TradePlan } from "@/lib/agent/types"
import type {
  PlanningAgentInput,
  PlanningAgentOutput,
  PlanningAggregationResult,
  PlanningAggregationLlmResult,
  PlanningSubagentPlan,
  PerspectiveBreakdownEntry,
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
 * @function fallbackAggregation
 * @description Deterministic merge fallback (spec §9.2) used when the
 *   AGGREGATE LLM call never succeeded but a plan must still be built
 *   (forced accept / loop exhausted). Majority vote for side only — every
 *   number is filled deterministically by enrichAggregation (confidence via
 *   deterministicConfidence, prices/size/leverage via computeTradeNumbers).
 * @param {PerspectiveReport[]} reports - Accumulated perspective reports.
 * @returns {PlanningAggregationLlmResult} Narrow narrative aggregation.
 */
function fallbackAggregation(reports: PerspectiveReport[]): PlanningAggregationLlmResult {
  // Guard: no reports → cannot compute anything meaningful, force NO_TRADE
  if (reports.length === 0) {
    return {
      side: "no_trade",
      thesis: "No subagent data — planning timed out before reports were available",
      reasoning: "Planning loop exhausted before any perspective subagent completed",
      risk_flags_text: "",
      consensus_alignment: 0,
      contradictions: [],
      no_trade_reason: "Planning timed out — no subagent reports available",
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
    risk_flags_text: "",
    consensus_alignment: 0,
    contradictions: [],
  }
}

/**
 * @interface EnrichAggregationInput
 * @description Inputs to enrichAggregation. `narrative` carries the LLM's side
 *   and prose; every number is derived deterministically from the tool inputs
 *   and the DD context.
 * @property {PlanningAggregationLlmResult} narrative - LLM narrative (side/thesis/reasoning).
 * @property {PerspectiveReport[]} reports - The perspective reports (signal + vote inputs).
 * @property {FactorScoreInput[]} factorScores - DD factor scores (deterministic confidence input).
 * @property {HistoricalMatchInput} historicalMatches - Graph-memory pattern stats.
 * @property {number} markPrice - Pre-fetched mark price (get_mark_price result).
 * @property {number} atr - Pre-fetched ATR(14) (compute_atr result).
 * @property {number} equity - Pre-fetched account equity in USDC.
 * @property {RiskThresholds} thresholds - User risk thresholds (max leverage,
 *   risk per trade).
 * @property {number} targetProfitPercent - Effective target profit percent.
 * @property {"long" | "short"} [sideOverride] - L3 override side (forced path).
 * @property {number} [confidenceFloor] - L3 override confidence floor.
 * @property {number} [ddMultiplier] - Partial-DD confidence penalty multiplier.
 */
interface EnrichAggregationInput {
  narrative: PlanningAggregationLlmResult
  reports: PerspectiveReport[]
  factorScores: FactorScoreInput[]
  historicalMatches: HistoricalMatchInput
  markPrice: number
  atr: number
  equity: number
  thresholds: RiskThresholds
  targetProfitPercent: number
  sideOverride?: "long" | "short"
  confidenceFloor?: number
  ddMultiplier?: number
}

/**
 * @function strongestReportSide
 * @description The long/short side carried by the highest-confidence report
 *   (report.confidence ?? score ?? 0), or undefined when no report sides
 *   long/short. Used to judge L3-override feasibility when the aggregation
 *   narrative abstains: the rescue candidate's trade geometry decides whether a
 *   strong minority signal may be rescued from a no_trade majority.
 * @param {PerspectiveReport[]} reports - The perspective reports.
 * @returns {"long" | "short" | undefined} The strongest non-no_trade side.
 */
function strongestReportSide(reports: PerspectiveReport[]): "long" | "short" | undefined {
  let best: "long" | "short" | undefined
  let bestConf = 0
  for (const r of reports) {
    if (r.side === "no_trade") continue
    const conf = r.confidence ?? r.score ?? 0
    if (conf > bestConf) {
      bestConf = conf
      best = r.side
    }
  }
  return best
}

/**
 * @function enrichAggregation
 * @description Assembles the full PlanningAggregationResult from the LLM
 *   narrative + deterministic computations. Single source of the final trade
 *   numbers: confidence = deterministicConfidence(...).score (optionally floored
 *   by the L3 override and multiplied by the partial-DD penalty), prices/size
 *   from computeTradeNumbers (mark price, ATR, compute_sltp / compute_position_size
 *   math, thresholds), risk_flags = mergeRiskFlags over the reports' structured
 *   enum flags, and profit_feasible from computeProfitFeasibility. Any missing
 *   tool input forces {no_trade: true} via computeTradeNumbers — no LLM-guessed
 *   number can survive. When the narrative side is no_trade but a strong
 *   long/short minority exists, profit_feasible is judged against the candidate
 *   side's geometry (L3 feasibility gate). Pure — no I/O (all inputs pre-fetched
 *   by the orchestrator).
 * @param {EnrichAggregationInput} input - Narrative + deterministic inputs.
 * @returns {PlanningAggregationResult} Full deterministic aggregation.
 */
function enrichAggregation(input: EnrichAggregationInput): PlanningAggregationResult {
  const side = input.sideOverride ?? input.narrative.side
  const det = deterministicConfidence({
    side,
    factorScores: input.factorScores,
    historicalMatches: input.historicalMatches,
    signals: input.reports.flatMap((r) => r.signals),
    votes: input.reports.map((r) => r.side),
  })
  // reason: L3 override floors the confidence at the rescued signal's value;
  // the partial-DD penalty then scales it (usable/planned factor ratio).
  const rawScore =
    input.confidenceFloor !== undefined ? Math.max(input.confidenceFloor, det.score) : det.score
  const confidenceScore = Math.round(rawScore * (input.ddMultiplier ?? 1))
  const confidence = confidenceScore / 100

  // reason: computeTradeNumbers is the single source of the money numbers —
  // entry from the mark price, SL/TP from compute_sltp math, size from
  // compute_position_size math, leverage from the risk engine. Any invalid or
  // missing input returns {no_trade: true, reason}.
  const numbersFor = (s: "long" | "short"): { entry: number; stopLoss: number; takeProfit: number; positionSizeUsdc: number } | null => {
    const sltp = computeSLTP(input.markPrice, input.atr, s)
    const positionSize = computePositionSize(
      input.equity,
      input.markPrice,
      sltp.stopLoss,
      input.thresholds.risk_per_trade_percent
    )
    const result = computeTradeNumbers({
      markPrice: input.markPrice,
      atr: input.atr,
      sltpResult: sltp,
      positionSizeResult: { positionSizeUsdc: positionSize.positionSizeUsdc },
      thresholds: input.thresholds,
      equity: input.equity,
      side: s,
      confidence,
    })
    if ("no_trade" in result) return null
    return {
      entry: result.entry,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      positionSizeUsdc: result.positionSizeUsdc,
    }
  }

  let entry = 0
  let stopLoss = 0
  let takeProfit = 0
  let positionSizeUsdc = 0
  let profitFeasible = false
  if (side !== "no_trade") {
    const numbers = numbersFor(side)
    if (numbers !== null) {
      entry = numbers.entry
      stopLoss = numbers.stopLoss
      takeProfit = numbers.takeProfit
      positionSizeUsdc = numbers.positionSizeUsdc
      // reason: profit_feasible is computed in code from the deterministic
      // geometry (R:R ≥ min, target within TP distance, target within 3×ATR) —
      // never from the LLM's judgment.
      profitFeasible = computeProfitFeasibility({
        entryPrice: numbers.entry,
        stopLoss: numbers.stopLoss,
        takeProfit: numbers.takeProfit,
        side,
        targetProfitPercent: input.targetProfitPercent,
        atr: input.atr,
      }).feasible
    }
  } else {
    // reason: L3 feasibility gate — when the narrative abstains but a strong
    // long/short minority exists, feasibility is judged on the candidate side's
    // geometry so the rescue rule can still fire (an abstention has no geometry
    // of its own). The returned numbers stay zero (side stays no_trade); the
    // override (if applied) recomputes them for the rescued side at the tail.
    const candidate = strongestReportSide(input.reports)
    if (candidate !== undefined) {
      const numbers = numbersFor(candidate)
      if (numbers !== null) {
        profitFeasible = computeProfitFeasibility({
          entryPrice: numbers.entry,
          stopLoss: numbers.stopLoss,
          takeProfit: numbers.takeProfit,
          side: candidate,
          targetProfitPercent: input.targetProfitPercent,
          atr: input.atr,
        }).feasible
      }
    }
  }

  return {
    side,
    thesis: input.narrative.thesis,
    reasoning: input.narrative.reasoning,
    confidence_score: confidenceScore,
    confidence_breakdown: det.breakdown,
    // reason: structured enum flags only — LLM prose never reaches risk_flags.
    risk_flags: mergeRiskFlags(input.reports.map((r) => r.risk_flags)),
    consensus_alignment: input.narrative.consensus_alignment,
    contradictions: input.narrative.contradictions,
    profit_feasible: profitFeasible,
    ...(input.narrative.no_trade_reason !== undefined
      ? { no_trade_reason: input.narrative.no_trade_reason }
      : {}),
    entry_price: entry,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    position_size_usdc: positionSizeUsdc,
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
  /** Pre-fetched ATR(14) — skips the internal fetch; undefined → fetch fallback. */
  atr?: number
  /** Pre-fetched mark price — used with `atr` for leverage sizing. */
  markPrice?: number
  /** Option B: user target was scaled down to the ATR-feasible target. */
  targetProfitScaled?: boolean
  /** Effective target percent used for the plan (scaled or user value). */
  targetProfitPercent?: number
  /** The user's original target before scaling. */
  targetProfitOriginalPercent?: number
}

/**
 * @function buildTradePlan
 * @description Assembles the final TradePlan from the accepted aggregation.
 *   NO_TRADE encodes a zero-size placeholder position: SL = entry*0.99,
 *   TP = entry*1.01, position_size_usdc 0, leverage 1 (spec §8.1 row 8).
 *   The aggregation's numbers are ALREADY the deterministic computeTradeNumbers
 *   output (entry/SL/TP/size) — buildTradePlan only recomputes contracts and
 *   leverage so they stay consistent with the same inputs. Leverage is the risk
 *   engine's deterministic OUTPUT (never LLM input): ATR is taken from the
 *   pre-fetched value when provided (fetched once per run by the orchestrator)
 *   or fetched once here (same source as the compute_atr tool) and fed to
 *   computeLeverage. Any ATR failure degrades to leverage 1 (conservative)
 *   instead of crashing the plan.
 * @param {BuildTradePlanParams} params - Plan assembly inputs.
 * @returns {Promise<TradePlan>} Zod-validated trade plan.
 */
async function buildTradePlan(params: BuildTradePlanParams): Promise<TradePlan> {
  const {
    asset,
    aggregation,
    equity,
    thresholds,
    autonomyDecision,
    iterations,
    totalMs,
    atr: prefetchedAtr,
    targetProfitScaled,
    targetProfitPercent,
    targetProfitOriginalPercent,
  } = params

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
  // taken from the orchestrator's pre-fetch when provided (one fetch per run)
  // or fetched once here (1h window, same source as the compute_atr tool); a
  // fetch or ATR failure degrades to leverage 1 (conservative), never a crash.
  let atr = 0
  if (!noTrade) {
    if (prefetchedAtr !== undefined && prefetchedAtr > 0) {
      atr = prefetchedAtr
    } else {
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
    risk_flags: targetProfitScaled
      ? [
          ...safeAggregation.risk_flags,
          `profit_target_scaled_from_${targetProfitOriginalPercent}_to_${targetProfitPercent}`,
        ]
      : safeAggregation.risk_flags,
    graph_patterns_used: [],
    consensus_alignment: safeAggregation.consensus_alignment,
    processingTimeMs: totalMs,
    iterations,
    timestamp: new Date().toISOString(),
    // reason: Option B metadata — effective vs original target, exposed so
    // the approval UI can show why the target deviated from the user's ask.
    ...(targetProfitScaled
      ? {
          profit_target_percent: targetProfitPercent,
          profit_target_original_percent: targetProfitOriginalPercent,
          profit_target_scaled: true,
        }
      : {}),
  })
}

/**
 * @function persistDecision
 * @description Non-blocking persistence of an accepted decision to the graph
 *   database. Failures are logged, never fatal (mirrors the DD agent's
 *   recordDDReport pattern, agent.ts:228-234). Persists the per-perspective
 *   breakdown (Phase 2 feed for dynamic perspective weighting — the outcome
 *   join needs it to score who was right).
 * @param {TradePlan} plan - The accepted trade plan.
 * @param {PlanningAgentInput} params - Run input (user/wallet context).
 * @param {"accepted" | "forced" | "no_trade"} [outcome] - How the plan was reached.
 * @param {PerspectiveBreakdownEntry[]} [perspectiveBreakdown] - Per-perspective
 *   verdicts from the final consensus evaluation.
 * @returns {void}
 */
function persistDecision(
  plan: TradePlan,
  params: PlanningAgentInput,
  outcome?: "accepted" | "forced" | "no_trade",
  perspectiveBreakdown?: PerspectiveBreakdownEntry[]
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
    // reason: optional — only persisted when consensus ran; feeds
    // queryPerspectivePerformance for dynamic weighting (Phase 2).
    ...(perspectiveBreakdown ? { perspectiveBreakdown } : {}),
  } as unknown as Parameters<typeof recordDecision>[0]).catch((e) =>
    console.warn("[PlanningAgent] Failed to persist decision:", e)
  )
}

/**
 * @function runPlanningAgent
 * @description Main planning swarm orchestrator (spec §6.2). Assumes a valid
 *   DD report is provided via input. Pre-fetches equity, mark price, ATR, and
 *   risk thresholds once (spec §16.4), then runs up to 3 Plan-Execute-Reflect
 *   iterations (fail fast: a loop deadline checked at each iteration start
 *   breaks out with a partial best-effort plan):
 *   1. PLAN — deterministic: buildFixedPerspectives (always 3 perspectives).
 *   2. EXECUTE — all planned perspective subagents in parallel, sharing one
 *      tool registry bound to the pre-fetched equity/mark price/ATR.
 *   3. AGGREGATE — llm aggregation (narrative only); null keeps the previous.
 *   4. EVALUATE — deterministic consensus (Layer 1) over an aggregation whose
 *      confidence/profit_feasible are computed deterministically (no LLM numbers).
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
  // and shared through the tool registry ctx + position sizing. A failure is
  // logged and degrades to 0 (tools report "equity not available") rather than
  // crashing the run.
  const equity = await fetchUserEquity(params.walletAddress).catch(() => {
    log("warn", "planning.equity_failed", { walletAddress: params.walletAddress })
    return 0
  })

  // reason: mark price + ATR(14) are pre-fetched ONCE per run and served from
  // the tool-registry context (get_mark_price / compute_atr read ctx first) —
  // 3 perspectives × N tool calls previously re-fetched the same data every
  // call. Failures degrade to 0 (tools fall back to their own fetches).
  const [prefetchedMarkPrice, prefetchedAtr] = await Promise.all([
    fetchMarkPrice(params.asset).catch(() => 0),
    fetchCandlesForATR(params.asset, "1h", 20)
      .then((candles) => computeATR(candles, 14))
      .catch(() => 0),
  ])

  // reason: Option B (profit-target scaling) — when the user's target profit
  // exceeds the maximum realistic move (3×ATR), the effective target used for
  // feasibility and planning is capped at 3×ATR and the plan is flagged for
  // HUMAN approval (deviating from the user's instruction requires consent).
  // Scaling is skipped entirely when ATR/mark price are unavailable.
  const maxFeasibleTargetPercent =
    prefetchedMarkPrice > 0 && prefetchedAtr > 0
      ? Math.round(((3 * prefetchedAtr) / prefetchedMarkPrice) * 100 * 100) / 100
      : null
  const targetProfitScaled =
    maxFeasibleTargetPercent !== null && params.targetProfitPercent > maxFeasibleTargetPercent
  const targetProfitPercent = targetProfitScaled
    ? (maxFeasibleTargetPercent as number)
    : params.targetProfitPercent
  if (targetProfitScaled) {
    log("warn", "planning.target_scaled", {
      asset: params.asset,
      from: params.targetProfitPercent,
      to: targetProfitPercent,
      atrPercentOfPrice: Math.round(((prefetchedAtr / prefetchedMarkPrice) * 10000) / 100),
    })
  }

  // reason: risk thresholds are pre-fetched once — needed by computeTradeNumbers
  // (max_leverage, risk_per_trade_percent) during consensus enrichment AND by
  // the autonomy gate at the tail.
  const thresholds = await getRiskThresholds(params.userId).catch(() => envDefaults())

  // reason: L1 dynamic weighting (Phase 2) — perspective weights come from
  // historical performance in graph memory; any failure degrades to cold-start
  // uniform weights (never crashes the run). The WTA boost is applied here so
  // the whole loop (and every re-deploy) sees the same weights.
  const perspectivePerf = await queryPerspectivePerformance(params.userId).catch(() => null)
  const weights = applyWta(
    computePerspectiveWeights(perspectivePerf, DEFAULT_WEIGHT_CONFIG),
    perspectivePerf,
    DEFAULT_WEIGHT_CONFIG
  )
  log("info", "planning.weights", { weights, hasHistory: perspectivePerf !== null })

  // reason: deterministicConfidence inputs (SA3) — factor scores from the DD
  // report sections (null = failed factor, counts as non-aligned) and graph
  // pattern stats from get_graph_patterns (a "profit" outcome aligns with the
  // proposed side; totalCount 0 → conservative no-history default). Both feed
  // every consensus evaluation and the final plan; neither ever involves the LLM.
  const ddFactorScores: FactorScoreInput[] = Object.values(ddReport.sections ?? {}).map((s) => ({
    score: typeof s?.score === "number" ? s.score : null,
  }))
  const ddSignals = Object.values(ddReport.sections ?? {}).flatMap((s) => s?.signals ?? [])
  const graphPatterns = await queryGraphPatterns(params.asset, ddSignals).catch(() => [])
  const historicalMatches: HistoricalMatchInput = {
    alignedCount: graphPatterns.filter((p) => /profit/i.test(p.outcome)).length,
    totalCount: graphPatterns.length,
  }

  let allReports: PerspectiveReport[] = []
  let aggregation: PlanningAggregationLlmResult | null = null
  const reDeployCounts: Record<string, number> = {}

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

    // --- PLAN (deterministic) ---
    const planT0 = Date.now()
    // reason: the fixed planner (SA5) always deploys exactly 3 perspectives
    // with static instruction templates — no LLM PLAN/RE-PLAN call, no empty
    // fallback. The loop re-runs the same fixed plan on RE-DEPLOY iterations.
    const subagentPlans: PlanningSubagentPlan[] = buildFixedPerspectives(ddReport).map(
      (perspectivePlan, i) => ({
        perspective: perspectivePlan.perspective,
        instruction: perspectivePlan.instructions,
        priority: i + 1,
      })
    )
    timing.planMs += Date.now() - planT0

    // --- EXECUTE ---
    const execT0 = Date.now()
    const tools = buildPlanningToolRegistry({
      walletAddress: params.walletAddress,
      userId: params.userId,
      asset: params.asset,
      equity,
      // reason: pre-fetched once per run — tools serve these from ctx instead
      // of re-fetching (latency fix: 3 perspectives × N calls previously
      // re-fetched the same mark price and candles).
      markPrice: prefetchedMarkPrice > 0 ? prefetchedMarkPrice : undefined,
      atr: prefetchedAtr > 0 ? prefetchedAtr : undefined,
    })
    const newReports = await Promise.all(
      subagentPlans.map((sp) =>
        runPerspectiveSubagent({
          perspective: sp.perspective,
          instruction: sp.instruction,
          asset: params.asset,
          ddReport,
          targetProfitPercent,
          tools,
        })
      )
    )
    timing.executeMs += Date.now() - execT0

    // Map-dedupe by perspective — latest report per perspective wins, so
    // evaluateConsensus always sees the freshest 3 reports. MUST run before
    // the fail-fast check below: the tail builds the best-effort plan from
    // allReports, so the deadline break must not discard the fresh reports.
    allReports = Array.from(
      new Map([...allReports, ...newReports].map((r) => [r.perspective, r])).values()
    )

    // reason: fail-fast mid-iteration (latency bound) — if the global loop
    // deadline passed during EXECUTE (the most expensive phase), skip
    // AGGREGATE + EVALUATE entirely: the tail builds a best-effort plan from
    // the reports already collected instead of spending another 60s+ on LLM
    // calls the deadline would discard anyway.
    if (Date.now() - t0 > (Number(process.env.PLANNING_LOOP_TIMEOUT_MS) || PLANNING_LOOP_TIMEOUT_MS)) {
      log("warn", "planning.timeout_post_execute", {
        iteration,
        elapsedMs: Date.now() - t0,
        collectedReports: newReports.length,
      })
      finalIterations = iteration + 1
      outcome = "exhausted"
      break
    }

    // --- AGGREGATE ---
    const aggT0 = Date.now()
    const agg = await aggregate({
      reports: allReports,
      ddReport,
      targetProfitPercent,
    })
    if (agg) {
      aggregation = agg
    } else {
      errors.push(`Aggregation step returned null on iteration ${iteration + 1}`)
      // reason: keep the previous narrative as fallback context; the
      // enrichment below recomputes confidence/profit_feasible fresh from the
      // current reports, so stale numbers never leak into the decision.
    }
    timing.aggregateMs += Date.now() - aggT0

    // --- ENRICH (deterministic numbers for this evaluation) ---
    // reason: the LLM aggregation carries no numbers — confidence and
    // profit_feasible are computed here from the current reports + DD context
    // + tool inputs so evaluateConsensus's ACCEPT rules and the L3 feasibility
    // gate see the deterministic values.
    const evaluationAggregation: PlanningAggregationResult | null = aggregation
      ? enrichAggregation({
          narrative: aggregation,
          reports: allReports,
          factorScores: ddFactorScores,
          historicalMatches,
          markPrice: prefetchedMarkPrice,
          atr: prefetchedAtr,
          equity,
          thresholds,
          targetProfitPercent,
        })
      : null

    // --- EVALUATE (Layer 1) ---
    const evalT0 = Date.now()
    const evaluation = evaluateConsensus(
      allReports,
      evaluationAggregation,
      degradedFactors.length > 0 ? degradedFactors : undefined,
      weights,
      // reason: SA3 — deterministic side scores (DD context) instead of the
      // LLM's verbalized per-perspective confidence.
      { factorScores: ddFactorScores, historicalMatches }
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

  const finalNarrative = aggregation ?? fallbackAggregation(allReports)

  // reason: L3 strong-minority override — when consensus rescued a side from
  // the no_trade majority (RE-DEPLOY → cap → forced), the LLM narrative may
  // still say no_trade. Override its side with the deterministic side and
  // floor the confidence at the rescued signal's value so the forced path
  // carries the signal instead of killing it.
  const override =
    latestConsensus?.overrideRule.applied === true
      ? {
          side: latestConsensus.overrideRule.side,
          confidenceFloor: latestConsensus.overrideRule.confidence,
        }
      : undefined

  // reason: a consensus NO_TRADE wins over the LLM narrative side — a
  // majority abstention must produce a NO_TRADE plan regardless of what the
  // aggregator synthesized. (The old code let the LLM side through here.)
  const narrativeForPlan: PlanningAggregationLlmResult =
    outcome === "no_trade" && finalNarrative.side !== "no_trade"
      ? { ...finalNarrative, side: "no_trade" }
      : finalNarrative

  // reason: single deterministic assembly — confidence (with override floor +
  // DD penalty), trade numbers (computeTradeNumbers), risk flags
  // (mergeRiskFlags), profit feasibility (computeProfitFeasibility).
  const finalAggregation = enrichAggregation({
    narrative: narrativeForPlan,
    reports: allReports,
    factorScores: ddFactorScores,
    historicalMatches,
    markPrice: prefetchedMarkPrice,
    atr: prefetchedAtr,
    equity,
    thresholds,
    targetProfitPercent,
    ...(override ? { sideOverride: override.side, confidenceFloor: override.confidenceFloor } : {}),
    ddMultiplier: ddConfidenceMultiplier,
  })

  // reason: the deterministic confidence result object (never an LLM value)
  // drives the autonomy gate — score already carries the DD penalty + override.
  const deterministicResult: DeterministicConfidenceResult = {
    score: finalAggregation.confidence_score,
    breakdown: finalAggregation.confidence_breakdown,
  }
  // reason: scaled profit target deviates from the user's explicit instruction
  // — the plan MUST go through human approval regardless of the confidence
  // gate (Option B: fallback ATR target + approval).
  const autonomyDecision: AutonomyDecision =
    outcome === "no_trade"
      ? "auto"
      : targetProfitScaled
        ? "approve"
        : autonomyGate(
            deterministicResult,
            finalAggregation.position_size_usdc,
            thresholds
          )

  const tradePlan = await buildTradePlan({
    asset: params.asset,
    aggregation: finalAggregation,
    equity,
    thresholds,
    autonomyDecision,
    iterations: finalIterations,
    totalMs,
    // reason: pre-fetched values avoid a second ATR fetch inside buildTradePlan
    // (0 → buildTradePlan falls back to its own fetch, preserving old behavior).
    atr: prefetchedAtr > 0 ? prefetchedAtr : undefined,
    markPrice: prefetchedMarkPrice > 0 ? prefetchedMarkPrice : undefined,
    // reason: Option B target-scaling metadata rides on the plan so the API
    // and dashboard can show "target scaled from X% to Y%, awaiting approval".
    targetProfitScaled,
    targetProfitPercent,
    targetProfitOriginalPercent: params.targetProfitPercent,
  })

  // reason: approval_required = run that still needs human approval — partial
  // DD penalty OR scaled profit target; distinct from "partial" (loop
  // exhaustion) and from complete runs that happen to carry "approve".
  const status: PlanningAgentOutput["status"] =
    tradePlan.action === "NO_TRADE" || outcome === "no_trade"
      ? "no_trade"
      : (ddConfidenceMultiplier < 1 || targetProfitScaled) && autonomyDecision === "approve"
        ? "approval_required"
        : outcome === "accepted"
          ? "complete"
          : "partial"

  if (outcome === "accepted" || outcome === "forced" || outcome === "no_trade") {
    persistDecision(
      tradePlan,
      params,
      outcome,
      // reason: Phase 2 feed — the per-perspective verdicts are persisted with
      // the decision so queryPerspectivePerformance can score who was right.
      latestConsensus?.perspectiveBreakdown
    )
  }

  log("info", "planning.completed", { asset: params.asset, status, outcome, targetProfitScaled })

  return {
    report: tradePlan,
    timing: { ...timing, totalMs },
    iterations: finalIterations,
    status,
    // reason: how the final decision was reached — "consensus" (ACCEPT via
    // Layer 1), "forced" (re-deploy cap), "exhausted" (timeout), "no_trade".
    // Disambiguates a NO_TRADE that came from loop exhaustion vs consensus.
    decisionPath:
      outcome === "accepted"
        ? "consensus"
        : outcome === "no_trade"
          ? "no_trade"
          : outcome === "forced"
            ? "forced"
            : "exhausted",
    // reason: spread keeps the key ABSENT when consensus never ran (dd-gate
    // failure path throws earlier) — same omit-when-absent contract as ddCoverage.
    ...(latestConsensus
      ? {
          consensus: {
            perspectiveBreakdown: latestConsensus.perspectiveBreakdown,
            noTradeReasonDetail: latestConsensus.noTradeReasonDetail,
            weights: latestConsensus.weights,
            sideScores: latestConsensus.sideScores,
            overrideRule: latestConsensus.overrideRule,
          },
        }
      : {}),
  }
}
