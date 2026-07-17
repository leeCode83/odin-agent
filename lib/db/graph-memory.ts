import type { GraphPattern } from "@/lib/agent/types"
import { GraphCollectionNames } from "@/lib/db/arango-types"
import { getDb } from "@/lib/db/arango-client"

/**
 * @function queryGraphPatterns
 * @description Queries the ArangoDB graph for trading patterns matching signals.
 * Traverses decision → TRIGGERED_BY → signal edges and decision → RESULTED_IN → outcome edges.
 * @param {string} asset - The asset to query for.
 * @param {string} category - The category of the asset.
 * @param {string[]} signals - Signal names to match against historical patterns.
 * @returns {Promise<GraphPattern[]>} Array of historical patterns and outcomes.
 */
export async function queryGraphPatterns(
  asset: string,
  category: string,
  signals: string[]
): Promise<GraphPattern[]> {
  try {
    const db = getDb()
    if (!db) return []

    const { DECISIONS, EDGE_TRIGGERED_BY, EDGE_RESULTED_IN } = GraphCollectionNames
    const aqlQuery = `
      FOR d IN @@decisions
      FILTER d.asset == @asset AND d.category == @category
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
      category,
      signals,
    })

    const results = await cursor.all()
    return results || []
  } catch {
    return []
  }
}
