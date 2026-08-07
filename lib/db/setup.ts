/**
 * @file setup.ts
 * @description One-time ArangoDB setup: creates all document + edge collections and the odin_graph
 * with proper edge definitions. Idempotent — safe to run multiple times.
 * @module db
 * @layer repository
 */
import { createArangoClient } from "./arango-client"

const DOC_COLLECTIONS = ["decisions", "signals", "outcomes", "assets", "dd_reports", "paper_trades"] as const
const EDGE_COLLECTIONS = ["decision_analyzed", "decision_triggered_by", "decision_resulted_in", "decision_has_factorreport"] as const

const GRAPH_NAME = "odin_graph"
const EDGE_DEFINITIONS = [
  { collection: "decision_analyzed", from: ["decisions"], to: ["assets"] },
  { collection: "decision_triggered_by", from: ["decisions"], to: ["signals"] },
  { collection: "decision_resulted_in", from: ["decisions"], to: ["outcomes"] },
  { collection: "decision_has_factorreport", from: ["decisions"], to: ["signals"] },
]

/**
 * @function teardownArangoGraph
 * @description Drops the named graph and all document/edge collections. Safe to call on empty DB.
 * Drops graph first (required before dropping edge collections), then collections individually.
 * Non-fatal for missing resources.
 * @returns {Promise<void>}
 */
export async function teardownArangoGraph(): Promise<void> {
  const db = createArangoClient()
  const dbName = process.env.ARANGO_DB || "odin"
  console.log(`Tearing down "${dbName}"...`)

  async function drop(name: string, type: string): Promise<void> {
    try {
      await db.collection(name).drop()
      console.log(`  ✓ ${type} "${name}" dropped`)
    } catch (err) {
      const e = err as { errorNum?: number; code?: number }
      // errorNum 1203 = collection not found, 1229 = graph not found
      if (e.errorNum === 1203 || e.errorNum === 1229 || e.code === 404) {
        console.log(`  - ${type} "${name}" not found, skipping`)
      } else {
        throw err
      }
    }
  }

  // Drop graph first (required before dropping edge collections)
  try {
    await db.graph(GRAPH_NAME).drop()
    console.log(`  ✓ graph "${GRAPH_NAME}" dropped`)
  } catch (err) {
    const e = err as { errorNum?: number; code?: number }
    if (e.errorNum === 1229 || e.code === 404) {
      console.log(`  - graph "${GRAPH_NAME}" not found, skipping`)
    } else {
      throw err
    }
  }

  // Drop edge collections
  for (const name of EDGE_COLLECTIONS) {
    await drop(name, "edge collection")
  }

  // Drop document collections
  for (const name of DOC_COLLECTIONS.toReversed()) {
    await drop(name, "collection")
  }

  console.log("Teardown complete.")
}

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
