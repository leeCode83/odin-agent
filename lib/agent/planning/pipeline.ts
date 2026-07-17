import { DDReportSchema, TradePlanSchema } from "@/lib/agent/types"
import type { PerspectiveResult, PlanningPipelineInput, PlanningPipelineOutput } from "./types"
import { fetchMarkPrice, fetchUserEquity, fetchCandlesForATR } from "@/lib/data/hyperliquid"
import { queryGraphPatterns } from "@/lib/db/graph-memory"
import { getRiskThresholds } from "@/lib/db/risk-thresholds"
import { generatePerspective, aggregatePerspectives } from "./llm"
import { computeATR, computeSLTP, computePositionSize, capLeverage } from "./risk-engine"
import { autonomyGate } from "./gate"

/**
 * @class PlanningError
 * @description Custom error class for errors occurring during the planning pipeline.
 */
export class PlanningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanningError"
  }
}

/**
 * @function runPlanningPipeline
 * @description Executes the full trade planning pipeline, combining DD report analysis, risk thresholds, market data, and multiple LLM perspectives.
 * @param {PlanningPipelineInput} input - The input containing the DD report, user ID, and wallet address.
 * @returns {Promise<PlanningPipelineOutput>} The generated trade plan and execution timings.
 */
export async function runPlanningPipeline(
  input: PlanningPipelineInput
): Promise<PlanningPipelineOutput> {
  const ddReport = DDReportSchema.parse(input.ddReport)
  const errors: string[] = []
  const startTime = Date.now()

  // 1. Parallel fetch: mark price, equity, candles, thresholds, graph patterns
  const fetchStart = Date.now()
  const allSignals = Object.values(ddReport.sections).flatMap((s) => s.signals)
  const [markPrice, equity, candles, storedThresholds, graphPatterns] = await Promise.all([
    fetchMarkPrice(ddReport.asset).catch((e) => { errors.push(`mark_price: ${e.message}`); throw e; }),
    fetchUserEquity(input.walletAddress).catch((e) => { errors.push(`equity: ${e.message}`); throw e; }),
    fetchCandlesForATR(ddReport.asset).catch((e) => { errors.push(`candles: ${e.message}`); throw e; }),
    getRiskThresholds(input.userId).catch((e) => { errors.push(`thresholds: ${e.message}`); return null; }),
    queryGraphPatterns(ddReport.asset, ddReport.category, allSignals).catch((e) => { errors.push(`graph: ${e.message}`); return []; }),
  ])
  const fetchMs = Date.now() - fetchStart
  const thresholds = storedThresholds ?? { confidence_threshold: 70, max_position_usdc: 100, max_leverage: 10, risk_per_trade_percent: 1 }

  // 2. Three perspective LLM runs in parallel (thinking mode)
  const llmStart = Date.now()
  const [conservative, balance, aggressive] = await Promise.all([
    generatePerspective("conservative", ddReport, graphPatterns),
    generatePerspective("balance", ddReport, graphPatterns),
    generatePerspective("aggressive", ddReport, graphPatterns),
  ])

  const validPerspectives = [conservative, balance, aggressive].filter((p): p is PerspectiveResult => p !== null)
  if (validPerspectives.length === 0) {
    throw new PlanningError("All 3 LLM perspectives failed")
  }

  // 3. Aggregator LLM call (thinking mode)
  const aggregated = await aggregatePerspectives(validPerspectives, ddReport)
  if (!aggregated) {
    throw new PlanningError("Aggregator LLM call failed")
  }
  const llmMs = Date.now() - llmStart

  // 4. Deterministic risk engine
  const riskStart = Date.now()
  const atr = computeATR(candles)
  const { stopLoss, takeProfit } = computeSLTP(markPrice, atr, aggregated.side)
  const leverage = capLeverage(aggregated.leverage_suggested, thresholds.max_leverage)
  const { positionSizeUsdc, positionSizeContracts } = computePositionSize(equity, markPrice, stopLoss, thresholds.risk_per_trade_percent)
  const riskEngineMs = Date.now() - riskStart

  // 5. Autonomy gate
  const autonomyDecision = autonomyGate(aggregated.confidence_score, positionSizeUsdc, thresholds)

  const totalMs = Date.now() - startTime

  const plan = TradePlanSchema.parse({
    asset: ddReport.asset,
    side: aggregated.side,
    entry_price: markPrice,
    position_size_usdc: positionSizeUsdc,
    position_size_contracts: positionSizeContracts,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    leverage,
    confidence_score: aggregated.confidence_score,
    confidence_breakdown: aggregated.confidence_breakdown,
    thesis: aggregated.thesis,
    reasoning: aggregated.reasoning,
    autonomy_decision: autonomyDecision,
    risk_flags: aggregated.risk_flags,
    graph_patterns_used: graphPatterns,
    timestamp: new Date().toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  })

  return {
    plan,
    timing: { fetchMs, graphMs: fetchMs, llmMs, riskEngineMs, totalMs },
  }
}
