import { DDReportSchema, TradePlanSchema } from "@/lib/agent/types"
import type { Side, ConfidenceBreakdown } from "@/lib/agent/types"
import type { PerspectiveResult, PlanningPipelineInput, PlanningPipelineOutput } from "./types"
import { fetchUserEquity, fetchCandlesForATR } from "@/lib/data/hyperliquid"
import { queryGraphPatterns } from "@/lib/db/graph-memory"
import { getRiskThresholds } from "@/lib/db/risk-thresholds"
import { generatePerspective, aggregatePerspectives } from "./llm"
import { computeATR, computeSLTP, computePositionSize, capLeverage, computeEntryPrice } from "./risk-engine"
import { autonomyGate } from "./gate"

export class PlanningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanningError"
  }
}

export async function runPlanningPipeline(
  input: PlanningPipelineInput
): Promise<PlanningPipelineOutput> {
  const ddReport = DDReportSchema.parse(input.ddReport)
  const startTime = Date.now()

  const [equity, candles, graphPatterns, thresholds] = await Promise.all([
    fetchUserEquity(input.walletAddress).catch(() => 0),
    fetchCandlesForATR(ddReport.asset).catch(() => []),
    queryGraphPatterns(ddReport.asset, ddReport.category),
    getRiskThresholds(input.userId),
  ])

  const afterFetchMs = Date.now()
  const equityMs = afterFetchMs - startTime
  const candleMs = afterFetchMs - startTime
  const graphMs = afterFetchMs - startTime

  const [conservative, balance, aggressive] = await Promise.all([
    generatePerspective("conservative", ddReport, graphPatterns),
    generatePerspective("balance", ddReport, graphPatterns),
    generatePerspective("aggressive", ddReport, graphPatterns),
  ])

  const validPerspectives = [conservative, balance, aggressive].filter((p): p is PerspectiveResult => p !== null)
  if (validPerspectives.length === 0) {
    throw new PlanningError("All 3 LLM perspectives failed")
  }

  const afterLLMMs = Date.now()
  const llmMs = afterLLMMs - afterFetchMs

  const aggregated = await aggregatePerspectives(validPerspectives, ddReport)

  const entry = await computeEntryPrice(ddReport.asset)
  const atr = computeATR(candles, 14)

  const best = [...validPerspectives].sort((a, b) => b.confidence - a.confidence)[0]
  const side: Side = aggregated?.direction || best.side
  const { stopLoss, takeProfit } = computeSLTP(entry, atr, side)
  const leverage = capLeverage(best.leverage, thresholds.maxLeverage)
  const { positionSizeUsdc, positionSizeContracts } = computePositionSize(equity, entry, stopLoss, thresholds.riskPerTradePercent)

  const afterRiskMs = Date.now()
  const riskMs = afterRiskMs - afterLLMMs

  let confidenceScore: number
  let confidenceBreakdown: ConfidenceBreakdown

  if (aggregated) {
    confidenceBreakdown = aggregated.confidence
    confidenceScore = Math.round(
      (aggregated.confidence.factor_alignment + aggregated.confidence.historical_match + aggregated.confidence.signal_strength) / 3
    )
  } else {
    confidenceBreakdown = { factor_alignment: 50, historical_match: 50, signal_strength: 50 }
    confidenceScore = best.confidence
  }

  const autonomyDecision = autonomyGate(confidenceScore, positionSizeUsdc, thresholds)

  const totalMs = Date.now() - startTime

  const tradePlan = TradePlanSchema.parse({
    asset: ddReport.asset,
    side,
    entry_price: entry,
    position_size_usdc: positionSizeUsdc,
    position_size_contracts: positionSizeContracts,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    leverage,
    confidence_score: confidenceScore,
    confidence_breakdown: confidenceBreakdown,
    thesis: aggregated?.thesis || validPerspectives[0]?.thesis || "",
    reasoning: aggregated?.reasoning || validPerspectives[0]?.reasoning || "",
    autonomy_decision: autonomyDecision,
    risk_flags: ddReport.risk_flags.concat(entry === 0 ? ["Entry price unavailable"] : []),
    graph_patterns_used: graphPatterns,
    timestamp: new Date().toISOString(),
  })

  return {
    tradePlan,
    timing: { equityMs, candleMs, graphMs, llmMs, riskMs, totalMs },
  }
}
