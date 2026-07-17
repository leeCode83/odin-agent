import { Database } from "arangojs"
import type { Graph } from "arangojs/graphs"

/**
 * @constant cachedDb
 * @description Cached instance of the ArangoDB Database.
 */
let cachedDb: Database | null = null

/**
 * @function createArangoClient
 * @description Creates a new instance of the ArangoDB client.
 * @returns {Database} The configured ArangoDB Database instance.
 */
export function createArangoClient(): Database {
  const url = process.env.ARANGO_URL || "http://localhost:8529"
  const databaseName = process.env.ARANGO_DB || "odin"
  const username = process.env.ARANGO_USER
  const password = process.env.ARANGO_PASSWORD

  const config: Record<string, unknown> = { url, databaseName }
  if (username) {
    config.auth = { username, password: password || "" }
  }

  return new Database(config)
}

/**
 * @function getDb
 * @description Retrieves the cached ArangoDB instance or creates a new one if not available.
 * @returns {Database | null} The database instance or null if connection fails.
 */
export function getDb(): Database | null {
  if (cachedDb) return cachedDb
  try {
    cachedDb = createArangoClient()
    return cachedDb
  } catch {
    return null
  }
}

/**
 * @function getGraph
 * @description Retrieves the graph instance from the database.
 * @param {Database} db - The ArangoDB Database instance.
 * @returns {Graph | null} The graph instance or null on failure.
 */
export function getGraph(db: Database): Graph | null {
  try {
    return db.graph("odin_graph")
  } catch {
    return null
  }
}
