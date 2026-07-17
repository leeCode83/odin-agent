import type { GraphPattern } from "@/lib/agent/types"
import { GraphCollectionNames } from "@/lib/db/arango-types"
import { getDb } from "@/lib/db/arango-client"

export async function queryGraphPatterns(
  asset: string,
  category: string
): Promise<GraphPattern[]> {
  try {
    const db = getDb()
    if (!db) return []

    const { DECISIONS } = GraphCollectionNames
    const aqlQuery = `
      FOR d IN @@decisions
      FILTER d.asset == @asset AND d.category == @category
      COLLECT pattern = d.category, outcome = d.decision WITH COUNT INTO frequency
      RETURN { pattern, outcome, frequency }
    `

    const cursor = await db.query<GraphPattern>(aqlQuery, {
      "@decisions": DECISIONS,
      asset,
      category,
    })

    const results = await cursor.all()
    return results || []
  } catch {
    return []
  }
}
