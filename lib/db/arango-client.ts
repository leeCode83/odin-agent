import { Database } from "arangojs"
import type { Graph } from "arangojs/graphs"

let cachedDb: Database | null = null

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

export function getDb(): Database | null {
  if (cachedDb) return cachedDb
  try {
    cachedDb = createArangoClient()
    return cachedDb
  } catch {
    return null
  }
}

export function getGraph(db: Database): Graph | null {
  try {
    return db.graph("odin_graph")
  } catch {
    return null
  }
}
