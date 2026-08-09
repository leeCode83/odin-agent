/**
 * @file execution/pipeline.ts
 * @description Execution pipeline: places a validated TradePlan as a
 *   Hyperliquid order bundle (entry + TP/SL) and monitors fills.
 * @module execution
 * @layer service
 */

import { TradePlanSchema } from "@/lib/agent/types"
import { getAgentSigner, getExchangeClient, getAssetIndex } from "./client"
import { buildOrders } from "./orders"
import { subscribeFill } from "./ws-monitor"
import { recordGraphMemory } from "@/lib/db/graph-memory"
import { getRiskThresholds } from "@/lib/db/risk-thresholds"
import { fetchUserEquity } from "@/lib/data/hyperliquid"
import { createLogger } from "@/lib/agent/shared/logger"
import { verifyTradePlanAgainstRisk, type AccountRiskState } from "./risk-gate"
import { withRetry, withTimeout } from "@/lib/utils"
import type { ExecutionPipelineInput, ExecutionPipelineOutput, ExecutionResult } from "./types"

/**
 * @class ExecutionError
 * @description Error thrown when the pipeline cannot or must not place orders
 *   (manual-approval plans, uninitialized agent wallet, NO_TRADE plans).
 */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecutionError"
  }
}

const fillTimeoutMs = Number(process.env.EXECUTION_FILL_TIMEOUT_MS) || 15_000
const hlTimeoutMs = Number(process.env.EXECUTION_FILL_TIMEOUT_MS) || 15_000

const log = createLogger({ service: "execution" })

/**
 * @function runExecutionPipeline
 * @description Executes a trade plan end-to-end: validates, guards, builds
 *   orders, places them, and monitors fills.
 * @param {ExecutionPipelineInput} input - Trade plan plus user/wallet context.
 * @returns {Promise<ExecutionPipelineOutput>} Execution result and timings.
 * @throws {ExecutionError} When the plan is NO_TRADE, requires approval, or
 *   the agent wallet is not initialized.
 */
export async function runExecutionPipeline(
  input: ExecutionPipelineInput
): Promise<ExecutionPipelineOutput> {
  const t0 = Date.now()
  const { tradePlan, userId, ddReport } = input

  const validated = TradePlanSchema.parse(tradePlan)

  // reason: defensive guard — a NO_TRADE plan must never reach order
  // placement; action is optional in the schema, so missing means LONG.
  if ((validated.action ?? "LONG") === "NO_TRADE") {
    throw new ExecutionError("Cannot execute a NO_TRADE plan")
  }

  if (validated.autonomy_decision === "approve") {
    throw new ExecutionError("TradePlan requires manual approval — cannot auto-execute")
  }

  const agentPk = process.env.AGENT_PRIVATE_KEY
  if (!agentPk) {
    throw new ExecutionError("Agent wallet not initialized. Call POST /api/agent/execution/init first")
  }

  const thresholds = await getRiskThresholds(userId)
  let accountState: AccountRiskState = {}
  try {
    accountState = { equityUsdc: await fetchUserEquity(input.walletAddress) }
  } catch (err) {
    log("warn", "risk_gate_equity_unavailable", { userId, error: String(err) })
  }
  const riskCheck = verifyTradePlanAgainstRisk(validated, { thresholds, accountState })
  if (!riskCheck.ok) {
    log("error", "risk_gate_rejected", { asset: validated.asset, side: validated.side, reasons: riskCheck.reasons })
    throw new ExecutionError(`TradePlan rejected by execution risk gate: ${riskCheck.reasons.join("; ")}`)
  }

  const { assetIndex, szDecimals } = await getAssetIndex(validated.asset)

  const buildStart = Date.now()
  const orders = buildOrders(validated, assetIndex, szDecimals)
  const buildMs = Date.now() - buildStart

  const placeStart = Date.now()
  const account = getAgentSigner(agentPk)
  const client = getExchangeClient(account)

  await withRetry(() => withTimeout(client.updateLeverage({
    asset: assetIndex,
    isCross: true,
    leverage: validated.leverage,
  }), hlTimeoutMs), { retries: 2 })

  const result = await withRetry(() => withTimeout(client.order({
    orders: [orders.entry, orders.takeProfit, orders.stopLoss],
    grouping: "normalTpsl",
  }), hlTimeoutMs), { retries: 2 })
  const placeMs = Date.now() - placeStart

  const responseData = result.response?.data
  const statuses = (responseData?.statuses as Array<{ resting?: { oid: number }; filled?: { oid: number }; error?: string } | string>) ?? []

  const parseOid = (s: unknown): number => {
    if (s && typeof s === "object") {
      const obj = s as Record<string, unknown>
      if (obj.resting && typeof obj.resting === "object") return (obj.resting as Record<string, unknown>).oid as number
      if (obj.filled && typeof obj.filled === "object") return (obj.filled as Record<string, unknown>).oid as number
    }
    return 0
  }

  const orderIds = [parseOid(statuses[0]), parseOid(statuses[1]), parseOid(statuses[2])]

  let fillStatus: "pending" | "filled" | "partial" | "none" = "pending"
  let fillAmount: string | null = null
  let fillPrice: string | null = null

  const fillResults = await subscribeFill(orderIds.filter((id) => id > 0), fillTimeoutMs)
  const filledOrders = fillResults.filter((r) => r.status === "filled")
  if (filledOrders.length > 0) {
    fillStatus = filledOrders.length >= orderIds.length ? "filled" : "partial"
    fillAmount = filledOrders[0].fillAmount ?? null
    fillPrice = filledOrders[0].fillPrice ?? null
  } else if (fillResults.length > 0) {
    fillStatus = "none"
  }

  const execution: ExecutionResult = {
    status: "placed",
    orders: [
      { type: "entry", oid: orderIds[0], status: fillStatus === "filled" ? "filled" : "open" },
      { type: "take_profit", oid: orderIds[1], status: "open" },
      { type: "stop_loss", oid: orderIds[2], status: "open" },
    ],
    groupId: "normalTpsl",
    fillStatus,
    fillAmount,
    fillPrice,
    timestamp: new Date().toISOString(),
  }

  const graphStart = Date.now()
  try {
    const signals = ddReport
      ? Object.entries(ddReport.sections).flatMap(([factor, section]) =>
          section.signals.map((signal) => ({
            factor,
            signalType: signal,
            description: section.summary ?? "",
            strength: section.score ?? 50,
          }))
        )
      : []

    const decisionKey = await recordGraphMemory({
      userId,
      asset: validated.asset,
      tradePlan: validated,
      signals,
    })
    execution.decisionKey = decisionKey
  } catch (err) {
    console.error("Graph memory recording failed (non-fatal):", err)
  }
  const graphMs = Date.now() - graphStart

  return {
    execution,
    timing: { buildMs, placeMs, graphMs, totalMs: Date.now() - t0 },
  }
}
