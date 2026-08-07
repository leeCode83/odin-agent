#!/usr/bin/env tsx
/**
 * @file scripts/setup-arangodb.ts
 * @description Fresh ArangoDB setup: drops ALL existing collections + graph, then recreates
 * everything from scratch. Run with: npm run setup
 * WARNING: Destroys all existing data in the database.
 */
import { loadEnvConfig } from "@next/env"
loadEnvConfig(process.cwd())

import { teardownArangoGraph, setupArangoGraph } from "../lib/db/setup"

async function main(): Promise<void> {
  await teardownArangoGraph()
  console.log("")
  await setupArangoGraph()
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Setup failed:", err)
    process.exit(1)
  })
