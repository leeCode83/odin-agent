import { TradePlanSchema } from "@/lib/agent/types"
import { getAgentSigner, getExchangeClient, getAssetIndex } from "./client"
import { buildOrders } from "./orders"
import { subscribeFill } from "./ws-monitor"
import { recordGraphMemory } from "@/lib/db/graph-memory"
import { withRetry, withTimeout } from "@/lib/utils"
import type { ExecutionPipelineInput, ExecutionPipelineOutput, ExecutionResult } from "./types"

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecutionError"
  }
}

const fillTimeoutMs = Number(process.env.EXECUTION_FILL_TIMEOUT_MS) || 15_000
const hlTimeoutMs = 15_000

export async function runExecutionPipeline(
  input: ExecutionPipelineInput
): Promise<ExecutionPipelineOutput> {
  const t0 = Date.now()
  const { tradePlan, userId, ddReport } = input

  const validated = TradePlanSchema.parse(tradePlan)
  if (validated.autonomy_decision === "approve") {
    throw new ExecutionError("TradePlan requires manual approval — cannot auto-execute")
  }

  const agentPk = process.env.AGENT_PRIVATE_KEY
  if (!agentPk) {
    throw new ExecutionError("Agent wallet not initialized. Call POST /api/agent/execution/init first")
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
