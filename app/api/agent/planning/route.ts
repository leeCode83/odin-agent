/**
 * @file app/api/agent/planning/route.ts
 * @description POST /api/agent/planning — runs the planning swarm pipeline
 *   for an asset (the DD agent runs internally as step 0, unless a fresh
 *   cached DD report exists — F2 reuse — or a valid ddReport is supplied).
 *   Request body is { asset, userId, walletAddress, targetProfitPercent? }
 *   (spec §12); errors follow spec §9.6 shapes (PLANNING_FAILED /
 *   CONSENSUS_FAILED) and the circuit breaker (spec §9.7) rejects with 503
 *   while tripped.
 * @module planning-route
 * @layer api
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { PlanningError } from "@/lib/agent/planning/pipeline"
import type { PlanningErrorCategory } from "@/lib/agent/planning/pipeline"
import { planningCircuitBreaker } from "@/lib/agent/planning/circuit-breaker"
import { log } from "@/lib/agent/planning/log"
import { TradePlanSchema, DDReportSchema } from "@/lib/agent/types"
import { runDDAgent } from "@/lib/agent/due-diligence/agent"
import { readRecentDDReport } from "@/lib/db/graph-memory"
import { assertAssetInUniverse, HyperliquidUniverseError } from "@/lib/agent/shared/hl-universe"
/**
 * @constant requiredBodySchema
 * @description Zod schema for the required request fields (spec §12).
 *   Now includes an optional ddReport for API decoupling.
 */
const requiredBodySchema = z.object({
  asset: z.string().min(1),
  userId: z.string().min(1),
  walletAddress: z.string().min(1),
  ddReport: DDReportSchema.optional(),
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
 * @constant CATEGORY_TO_HTTP_STATUS
 * @description Error taxonomy → HTTP code mapping (spec §9.6 extension):
 *   - "dd"       (422) — DD report unusable in a recoverable way (status
 *                        failed, zero usable factors, DD agent threw).
 *   - "llm"      (422) — DeepSeek API errors (401/429/5xx), LLM JSON parse
 *                        failures, empty LLM responses.
 *   - "data"     (502) — upstream provider failures (market data fetches:
 *                        candles, equity, other external data sources).
 *   - "internal" (500) — unexpected bugs, our own schema validation, or
 *                        consensus collapse (phase "evaluate").
 *   Circuit-breaker tripped → 503 (checked before the pipeline runs).
 */
const CATEGORY_TO_HTTP_STATUS: Record<PlanningErrorCategory, number> = {
  dd: 422,
  llm: 422,
  data: 502,
  internal: 500,
}

/**
 * @function POST
 * @description Runs the planning pipeline for an asset and returns the trade
 *   plan. Validates the body (400), rejects while the circuit breaker is
 *   tripped (503), and maps pipeline failures to §9.6 shapes with taxonomy
 *   HTTP codes (422 dd/llm, 502 data, 500 internal, CONSENSUS_FAILED for
 *   phase evaluate). A partial DD with usable factors returns 200 with
 *   status "approval_required" so the plan flows to the approval path.
 *   If a valid ddReport is provided, it skips the DD execution phase; else a
 *   fresh cached DD report (F2) is reused before falling back to running the
 *   DD agent. When the pipeline reports ddCoverage it is echoed back, and
 *   consensus details (2c: perspectiveBreakdown + noTradeReasonDetail) are
 *   echoed when consensus evaluation ran.
 * @param {NextRequest} req - Request with { asset, userId, walletAddress, targetProfitPercent?, ddReport? }.
 * @returns {Promise<NextResponse>} 200 { report, timing, iterations, status, ddCoverage?, consensus? },
 *   400 on invalid input, 503 PLANNING_UNAVAILABLE, 422/502/500 per taxonomy.
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
      { error: "Invalid request body (asset, userId, walletAddress required; ddReport must be valid if provided)", detail: required.error.issues },
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
    let ddReport = required.data.ddReport

    if (!ddReport) {
      // reason: F2 — reuse a fresh cached DD report (readRecentDDReport) before
      // running the 4-9 minute DD agent. Cache read first: a hit skips the
      // agent entirely; the read is wrapped defensively (it promises never to
      // throw, but a cache failure must never fail the request) — any throw
      // falls through to the runDDAgent path below.
      try {
        const cached = await readRecentDDReport(required.data.asset, required.data.userId)
        if (cached) {
          ddReport = cached
          // reason: report age = now minus the report's ISO timestamp (required
          // by DDReportSchema); guard NaN so the log can never throw — without a
          // parseable timestamp, log the hit without ageMs.
          const ageMs = Date.now() - Date.parse(cached.timestamp)
          if (Number.isFinite(ageMs)) {
            log("info", "planning.dd_cache_hit", { asset: required.data.asset, ageMs })
          } else {
            log("info", "planning.dd_cache_hit", { asset: required.data.asset })
          }
        }
      } catch {
        // reason: cache read failure falls through to the DD agent run.
      }
    }

    if (!ddReport) {
      // reason: validate the asset against the HL universe before running the
      // DD agent. Unknown asset → UNKNOWN_ASSET; HL unreachable → block
      // (HL_UNAVAILABLE), never fall through — if HL is down trading is
      // impossible anyway. Skips this check when a ddReport is supplied or a
      // fresh cache hit exists (F2).
      try {
        await assertAssetInUniverse(required.data.asset)
      } catch (e) {
        if (e instanceof HyperliquidUniverseError && e.kind === "asset_not_found") {
          throw new PlanningError(
            "UNKNOWN_ASSET",
            { phase: "dd", asset: required.data.asset, message: e.message },
            undefined,
            "dd"
          )
        }
        throw new PlanningError(
          "HL_UNAVAILABLE",
          { phase: "dd", asset: required.data.asset, message: String(e) },
          undefined,
          "data"
        )
      }
      try {
        ddReport = await runDDAgent({
          asset: required.data.asset,
          userId: required.data.userId,
          walletAddress: required.data.walletAddress,
        })
      } catch (e) {
        throw new PlanningError(
          "PLANNING_FAILED",
          { phase: "dd", reports: [], aggregation: null, ddReport: null, message: String(e) },
          undefined,
          "dd"
        )
      }
    }

    const output = await runPlanningPipeline({
      asset: required.data.asset,
      userId: required.data.userId,
      walletAddress: required.data.walletAddress,
      targetProfitPercent: targetProfitPercent.data,
      ddReport,
    })
    const validated = TradePlanSchema.parse(output.report)
    // reason: ddCoverage is optional pipeline metadata (F2/F3 — usable vs
    // failed factor counts); spread it into the response only when the
    // pipeline actually produced it (key absent when nothing failed).
    return NextResponse.json({
      report: validated,
      timing: output.timing,
      iterations: validated.iterations,
      // reason: the pipeline now carries the agent-level status; fall back to
      // the NO_TRADE-derived mapping for mocks/older pipeline results.
      status: output.status ?? (validated.action === "NO_TRADE" ? "no_trade" : "complete"),
      ...(output.ddCoverage ? { ddCoverage: output.ddCoverage } : {}),
      // reason: transparency (2c) — echo consensus only when the pipeline
      // produced it (key absent when consensus never ran).
      ...(output.consensus ? { consensus: output.consensus } : {}),
    })
  } catch (err) {
    console.error("Planning pipeline error:", err)
    if (err instanceof PlanningError) {
      // reason: feed the breakers (spec §9.7); recording must never mask the
      // real error, so each record call is guarded.
      if (err.detail?.phase === "evaluate") {
        // reason: consensus collapse is a swarm-internal outcome — no breaker
        // feed (existing behavior preserved).
      } else if (err.errorCategory === "dd") {
        try {
          planningCircuitBreaker.recordDDFailure()
        } catch {
          /* ignore */
        }
      } else {
        // reason: llm/data/internal failures all count against the LLM breaker
        // (the catch-all dependency breaker, existing behavior preserved).
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
        { status: CATEGORY_TO_HTTP_STATUS[err.errorCategory] ?? 500 }
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
