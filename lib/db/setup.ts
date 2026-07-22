/**
 * @file setup.ts
 * @description One-time ArangoDB setup: creates all document + edge collections and the odin_graph
 * with proper edge definitions. Idempotent — safe to run multiple times.
 * @module db
 * @layer repository
 */
import { createArangoClient } from "./arango-client"

const DOC_COLLECTIONS = ["decisions", "signals", "outcomes", "assets"] as const
const EDGE_COLLECTIONS = ["decision_analyzed", "decision_triggered_by", "decision_resulted_in"] as const

const GRAPH_NAME = "odin_graph"
const EDGE_DEFINITIONS = [
  { collection: "decision_analyzed", from: ["decisions"], to: ["assets"] },
  { collection: "decision_triggered_by", from: ["decisions"], to: ["signals"] },
  { collection: "decision_resulted_in", from: ["decisions"], to: ["outcomes"] },
]

/**
 * @function setupArangoGraph
 * @description Creates all ArangoDB document collections, edge collections, and the named graph
 * for Odin's graph memory. Safe to call multiple times — skips existing resources.
 * @returns {Promise<void>}
 * @throws {ArangoError} If database connection fails or an unexpected error occurs.
 */
export async function setupArangoGraph(): Promise<void> {
  const db = createArangoClient()
  const dbName = process.env.ARANGO_DB || "odin"
  const dbUrl = process.env.ARANGO_URL || "http://localhost:8529"
  console.log(`Connected to "${dbName}" at ${dbUrl}`)

  // Reason: ArangoError errorNum 1207 = "duplicate name" (already exists).
  async function create(name: string, fn: () => Promise<unknown>, type: string): Promise<void> {
    try {
      await fn()
      console.log(`  ✓ ${type} "${name}" created`)
    } catch (err) {
      if ((err as { errorNum?: number }).errorNum === 1207) {
        console.log(`  - ${type} "${name}" already exists`)
      } else {
        throw err
      }
    }
  }

  for (const name of DOC_COLLECTIONS) {
    await create(name, () => db.createCollection(name), "collection")
  }

  for (const name of EDGE_COLLECTIONS) {
    await create(name, () => db.createEdgeCollection(name), "edge collection")
  }

  await create(GRAPH_NAME, () => db.createGraph(GRAPH_NAME, EDGE_DEFINITIONS), "graph")

  console.log("ArangoDB setup complete.")
}
