/**
 * @file lib/db/graph-memory.ts
 * @description ArangoDB graph memory persistence and retrieval — trading
 *   patterns, decisions, signals, outcomes, and DD report caching.
 * @module db
 * @layer data
 */
import { createHash } from "crypto"
import type { GraphPattern, TradePlan } from "@/lib/agent/types"
import { DDReportSchema, type DDReport } from "@/lib/agent/types"
import { GraphCollectionNames } from "@/lib/db/arango-types"
import type { DecisionNode, SignalNode, OutcomeNode, DDReportNode } from "@/lib/db/arango-types"
import { getDb } from "@/lib/db/arango-client"

/**
 * @function queryGraphPatterns
 * @description Queries the ArangoDB graph for trading patterns matching signals.
 * @param {string} asset - The asset to query for.
 * @param {string[]} signals - Signal names to match against historical patterns.
 * @returns {Promise<GraphPattern[]>} Array of historical patterns and outcomes.
 */
export async function queryGraphPatterns(
  asset: string,
  signals: string[]
): Promise<GraphPattern[]> {
  try {
    const db = getDb()
    if (!db) return []

    const { DECISIONS, EDGE_TRIGGERED_BY, EDGE_RESULTED_IN } = GraphCollectionNames
    const aqlQuery = `
      FOR d IN @@decisions
      FILTER d.asset == @asset
      FOR s IN 1..1 OUTBOUND d @@edgeTriggered
        FILTER s.name IN @signals
      FOR o IN 1..1 OUTBOUND d @@edgeResulted
        COLLECT pattern = s.name, outcome = o.result WITH COUNT INTO frequency
        RETURN { pattern, outcome, frequency }
    `

    const cursor = await db.query<GraphPattern>(aqlQuery, {
      "@decisions": DECISIONS,
      "@edgeTriggered": EDGE_TRIGGERED_BY,
      "@edgeResulted": EDGE_RESULTED_IN,
      asset,
      signals,
    })

    const results = await cursor.all()
    return results || []
  } catch {
    return []
  }
}

/**
 * @function recordDecision
 * @description Inserts a DecisionNode into the decisions collection.
 * @param {Omit<DecisionNode, '_key'>} doc - Decision node document data.
 * @returns {Promise<string>} The _key of the inserted document.
 */
export async function recordDecision(doc: Omit<DecisionNode, "_key">): Promise<string> {
  const db = getDb()
  if (!db) throw new Error("ArangoDB not available")

  const result = await db.collection(GraphCollectionNames.DECISIONS).save(doc as Record<string, unknown>)
  return result._key
}

/**
 * @function recordSignals
 * @description Upserts SignalNode documents into the signals collection (dedup by factor + signalType).
 * @param {Array<{ factor: string; signalType: string; description: string; strength: number }>} signals - Signal data.
 * @param {string} userId - The user ID.
 * @returns {Promise<string[]>} Array of _key values for the upserted signals.
 */
export async function recordSignals(
  signals: Array<{ factor: string; signalType: string; description: string; strength: number }>,
  userId: string
): Promise<string[]> {
  const db = getDb()
  if (!db) throw new Error("ArangoDB not available")

  const keys: string[] = []
  const col = db.collection(GraphCollectionNames.SIGNALS)
  const now = new Date().toISOString()

  for (const s of signals) {
    const rawKey = `${userId}_${s.factor}_${s.signalType}`
    const signalKey = createHash("md5").update(rawKey).digest("hex")
    const doc: SignalNode = {
      _key: signalKey,
      factor: s.factor,
      signalType: s.signalType,
      description: s.description,
      strength: s.strength,
      timestamp: now,
    }
    await col.save(doc as unknown as Record<string, unknown>, { overwriteMode: "update" })
    keys.push(signalKey)
  }

  return keys
}

/**
 * @function recordGraphMemory
 * @description Orchestrates graph recording for a trade execution: inserts decision node,
 * signal nodes (if provided), asset node, and edges. Fire-and-forget — failure does not fail pipeline.
 * @param {object} params
 * @param {string} params.userId - User ID.
 * @param {string} params.asset - Asset name.
 * @param {TradePlan} params.tradePlan - The executed trade plan.
 * @param {Array<{ factor: string; signalType: string; description: string; strength: number }>} params.signals - Signal data from DD report.
 * @returns {Promise<string>} The _key of the inserted decision node.
 */
export async function recordGraphMemory(params: {
  userId: string
  asset: string
  tradePlan: TradePlan
  signals: Array<{ factor: string; signalType: string; description: string; strength: number }>
}): Promise<string> {
  const db = getDb()
  if (!db) throw new Error("ArangoDB not available")

  const now = new Date().toISOString()
  const { userId, asset, tradePlan, signals } = params

  await db.collection(GraphCollectionNames.ASSETS).save(
    { _key: asset, name: asset, category: "trade" } as Record<string, unknown>,
    { overwriteMode: "ignore" }
  )

  const decisionKey = await recordDecision({
    userId,
    asset,
    category: "trade",
    decision: tradePlan.side === "long" ? "buy" : "sell",
    side: tradePlan.side,
    confidence: tradePlan.confidence_score,
    tradePlan,
    autonomyDecision: tradePlan.autonomy_decision,
    timestamp: now,
  })

  if (signals.length > 0) {
    const signalKeys = await recordSignals(signals, userId)
    const edgeCol = db.collection(GraphCollectionNames.EDGE_TRIGGERED_BY)
    for (const sigKey of signalKeys) {
      await edgeCol.save({
        _from: `decisions/${decisionKey}`,
        _to: `signals/${sigKey}`,
        timestamp: now,
      })
    }
  }

  await db.collection(GraphCollectionNames.EDGE_ANALYZED).save({
    _from: `decisions/${decisionKey}`,
    _to: `assets/${asset}`,
    timestamp: now,
  })

  return decisionKey
}

/**
 * @function recordOutcome
 * @description Inserts an OutcomeNode and decision_resulted_in edge for a completed trade.
 * @param {string} decisionKey - The _key of the decision node.
 * @param {object} outcome
 * @param {"profit" | "loss" | "breakeven" | "cancelled"} outcome.result - Outcome result.
 * @param {number} [outcome.pnlUsdc] - Realized P&L in USDC.
 * @param {number} [outcome.pnlPercent] - Realized P&L as percentage.
 * @param {number} [outcome.exitPrice] - Exit price.
 * @param {string} [outcome.exitReason] - Reason for exit.
 * @returns {Promise<string>} The _key of the inserted outcome node.
 */
export async function recordOutcome(
  decisionKey: string,
  outcome: {
    result: "profit" | "loss" | "breakeven" | "cancelled"
    pnlUsdc?: number
    pnlPercent?: number
    exitPrice?: number
    exitReason?: string
  }
): Promise<string> {
  const db = getDb()
  if (!db) throw new Error("ArangoDB not available")

  const now = new Date().toISOString()
  const outcomeDoc: OutcomeNode = {
    result: outcome.result,
    pnlUsdc: outcome.pnlUsdc,
    pnlPercent: outcome.pnlPercent,
    exitPrice: outcome.exitPrice,
    exitReason: outcome.exitReason,
    timestamp: now,
  }

  const result = await db.collection(GraphCollectionNames.OUTCOMES).save(outcomeDoc as unknown as Record<string, unknown>)

  await db.collection(GraphCollectionNames.EDGE_RESULTED_IN).save({
    _from: `decisions/${decisionKey}`,
    _to: `outcomes/${result._key}`,
    timestamp: now,
  })

  return result._key
}

/**
 * @function recordDDReport
 * @description Persists a DD report to the dd_reports collection. Non-fatal on failure.
 * @param {Record<string, unknown>} report - The full DDReport object.
 * @param {string} userId - The user ID.
 * @param {string} walletAddress - The wallet address.
 * @returns {Promise<string>} The _key of the inserted document, or empty string on failure.
 */
export async function recordDDReport(
  report: Record<string, unknown>,
  userId: string,
  walletAddress: string
): Promise<string> {
  const db = getDb()
  if (!db) {
    console.warn("[graph-memory] ArangoDB unavailable, skipping DD report persistence")
    return ""
  }

  try {
    const doc: DDReportNode = {
      runId: crypto.randomUUID(),
      userId,
      walletAddress,
      asset: (report.asset as string) || "",
      report,
      timestamp: new Date().toISOString(),
      processingTimeMs: (report.processingTimeMs as number) || 0,
    }
    const result = await db.collection(GraphCollectionNames.DD_REPORTS).save(doc as unknown as Record<string, unknown>)
    return result._key
  } catch (err) {
    console.warn("[graph-memory] Failed to persist DD report:", err)
    return ""
  }
}

/**
 * @constant DEFAULT_DD_REPORT_TTL_MS
 * @description Default maximum age (4 hours) for a cached DD report to be
 *   considered reusable instead of re-running the DD agent.
 */
export const DEFAULT_DD_REPORT_TTL_MS = 4 * 60 * 60 * 1000

/**
 * @function readRecentDDReport
 * @description Reads the most recent cached DD report for an asset and user
 *   from the dd_reports collection, skipping the expensive DD agent run when a
 *   fresh-enough report exists. Always resolves — never rejects.
 * @param {string} asset - The asset the report was generated for.
 * @param {string} userId - The user the report was generated for.
 * @param {number} [maxAgeMs=DEFAULT_DD_REPORT_TTL_MS] - Maximum age of a
 *   reusable report in milliseconds.
 * @returns {Promise<DDReport | null>} The cached report if fresh and valid,
 *   otherwise null (missing, stale, invalid, or DB unavailable).
 */
export async function readRecentDDReport(
  asset: string,
  userId: string,
  maxAgeMs: number = DEFAULT_DD_REPORT_TTL_MS
): Promise<DDReport | null> {
  const db = getDb()
  if (!db) return null

  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    const aqlQuery = `
      FOR doc IN dd_reports
      FILTER doc.asset == @asset AND doc.userId == @userId AND doc.timestamp >= @cutoff
      SORT doc.timestamp DESC
      LIMIT 1
      RETURN doc.report
    `

    const cursor = await db.query<unknown>(aqlQuery, { asset, userId, cutoff })
    const docs = (await cursor.all()) as unknown[]
    const report = docs[0]
    if (!report) return null

    // reason: validate before returning — a corrupted or schema-incompatible
    // cached report must never reach callers as a usable DDReport.
    const parsed = DDReportSchema.safeParse(report)
    if (!parsed.success) {
      console.warn("[graph-memory] dd_cache_read cached report failed validation")
      return null
    }
    return parsed.data
  } catch (err) {
    // reason: non-fatal — cache read failure must degrade to null, never break
    // the pipeline by rejecting.
    console.warn("[graph-memory] dd_cache_read failed:", err)
    return null
  }
}
