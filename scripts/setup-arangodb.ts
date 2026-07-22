#!/usr/bin/env tsx
/**
 * @file scripts/setup-arangodb.ts
 * @description One-shot runner for ArangoDB graph setup.
 * Run with: npm run setup
 */
import { setupArangoGraph } from "../lib/db/setup"

setupArangoGraph()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Setup failed:", err)
    process.exit(1)
  })
