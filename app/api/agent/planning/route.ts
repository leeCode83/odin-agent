/**
 * @file app/api/agent/planning/route.ts
 * @description POST /api/agent/planning — runs the planning swarm pipeline
 *   for an asset (the DD agent runs internally as step 0). Request body is
 *   { asset, userId, walletAddress, targetProfitPercent? } (spec §12); errors
 *   follow spec §9.6 shapes (PLANNING_FAILED / CONSENSUS_FAILED) and the
 *   circuit breaker (spec §9.7) rejects with 503 while tripped.
 * @module planning-route
 * @layer api
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import { planningCircuitBreaker } from "@/lib/agent/planning/circuit-breaker"
import { TradePlanSchema } from "@/lib/agent/types"

/**
 * @constant requiredBodySchema
 * @description Zod schema for the required request fields (spec §12).
 */
const requiredBodySchema = z.object({
  asset: z.string().min(1),
  userId: z.string().min(1),
  walletAddress: z.string().min(1),
})

/**
 * @constant targetProfitPercentSchema
 * @description Optional profit target: positive decimal ≤ 1000 (resolved
 *   §16.5 — 100, 76, 20.5 allowed; minus, zero, and fraction strings rejected).
 */
const targetProfitPercentSchema = z.number().positive().max(1000).optional()

/**
 * @constant DD_BREAKER_RETRY_SECONDS
 * @description Nominal DD cooldown (spec §9.7). // reason: the breaker exposes
 *   no remaining-cooldown getter, so clients back off for the full window.
 */
const DD_BREAKER_RETRY_SECONDS = 60

/**
 * @constant LLM_BREAKER_RETRY_SECONDS
 * @description Nominal LLM cooldown (spec §9.7).
 */
const LLM_BREAKER_RETRY_SECONDS = 120

/**
 * @function POST
 * @description Runs the planning pipeline for an asset and returns the trade
 *   plan. Validates the body (400), rejects while the circuit breaker is
 *   tripped (503), and maps pipeline failures to §9.6 shapes (500).
 * @param {NextRequest} req - Request with { asset, userId, walletAddress, targetProfitPercent? }.
 * @returns {Promise<NextResponse>} 200 { report, timing, iterations, status },
 *   400 on invalid input, 503 PLANNING_UNAVAILABLE, 500 PLANNING_FAILED/CONSENSUS_FAILED.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const required = requiredBodySchema.safeParse(body)
  if (!required.success) {
    return NextResponse.json(
      { error: "asset, userId, and walletAddress required" },
      { status: 400 }
    )
  }

  const targetProfitPercent = targetProfitPercentSchema.safeParse(
    (body as Record<string, unknown>).targetProfitPercent
  )
  if (!targetProfitPercent.success) {
    return NextResponse.json(
      { error: "Invalid targetProfitPercent", detail: targetProfitPercent.error.issues },
      { status: 400 }
    )
  }

  const ddPanicked = planningCircuitBreaker.isDDPanicked()
  const llmPanicked = planningCircuitBreaker.isLLMPanicked()
  if (ddPanicked || llmPanicked) {
    return NextResponse.json(
      {
        error: "PLANNING_UNAVAILABLE",
        // reason: prefer the longer window when both breakers are tripped.
        retryAfterSeconds: llmPanicked ? LLM_BREAKER_RETRY_SECONDS : DD_BREAKER_RETRY_SECONDS,
      },
      { status: 503 }
    )
  }

  try {
    const output = await runPlanningPipeline({
      asset: required.data.asset,
      userId: required.data.userId,
      walletAddress: required.data.walletAddress,
      targetProfitPercent: targetProfitPercent.data,
    })
    const validated = TradePlanSchema.parse(output.report)
    return NextResponse.json({
      report: validated,
      timing: output.timing,
      iterations: validated.iterations,
      // reason: the pipeline drops the agent's complete/partial status, so the
      // only status signal at the route layer is the NO_TRADE action.
      status: validated.action === "NO_TRADE" ? "no_trade" : "complete",
    })
  } catch (err) {
    console.error("Planning pipeline error:", err)
    if (err instanceof PlanningError) {
      // reason: feed the breakers (spec §9.7); recording must never mask the
      // real error, so each record call is guarded.
      if (err.detail?.phase === "dd") {
        try {
          planningCircuitBreaker.recordDDFailure()
        } catch {
          /* ignore */
        }
      } else if (err.detail?.phase !== "evaluate") {
        // reason: generic and unknown-phase failures are LLM-layer or
        // equivalent — count them against the LLM breaker.
        try {
          planningCircuitBreaker.recordLLMFailure()
        } catch {
          /* ignore */
        }
      }
      return NextResponse.json(
        {
          error: err.detail?.phase === "evaluate" ? "CONSENSUS_FAILED" : "PLANNING_FAILED",
          message: err.message,
          details: err.detail ?? {},
          ...(err.processingTimeMs !== undefined ? { processingTimeMs: err.processingTimeMs } : {}),
        },
        { status: 500 }
      )
    }
    // reason: non-PlanningError (raw LLM-layer rejection escaping the
    // pipeline) — count it and return the generic §9.6 shape.
    try {
      planningCircuitBreaker.recordLLMFailure()
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      { error: "PLANNING_FAILED", message: String(err), details: {} },
      { status: 500 }
    )
  }
}
