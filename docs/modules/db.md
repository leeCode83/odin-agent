# Database Module

**Last Updated:** 2026-08-16

> ArangoDB client, graph memory persistence, and risk threshold storage.

---

## Overview

The database layer uses ArangoDB for graph memory (decisions, signals, outcomes, assets), DD report caching (`dd_reports`), and paper trade records (`paper_trades`). It also stores per-user risk thresholds.

---

## Files

### `lib/db/arango-client.ts`

- Singleton ArangoDB client (`createArangoClient`, `getDb`, `getGraph`).
- Reads `ARANGO_URL`, `ARANGO_DB`, `ARANGO_USER`, `ARANGO_PASSWORD` from env.

### `lib/db/graph-memory.ts`

- Graph memory helpers: `queryGraphPatterns`, `queryPerspectivePerformance`, `recordDecision`, `recordSignals`, `recordOutcome`, `recordGraphMemory`, `recordDDReport`, `readRecentDDReport`.
- DD cache TTL defaults to 4 hours (`DEFAULT_DD_REPORT_TTL_MS`).

### `lib/db/arango-types.ts`

- TypeScript interfaces for graph nodes (`DecisionNode`, `SignalNode`, `OutcomeNode`, `DDReportNode`) and collection names.

### `lib/db/risk-thresholds.ts`

- Reads user-specific risk thresholds from ArangoDB; falls back to env defaults.

### `lib/db/setup.ts`

- Bootstrap script run by `npm run setup`. Creates collections and the graph if missing.

---

## Key Functions / Classes / Exports

### `getDb()`

- Returns the cached `Database` instance or `null` on failure.

### `readRecentDDReport(asset, userId, maxAgeMs?)`

- Reads the newest cached DD report for an asset/user within the TTL.
- Validates with `DDReportSchema` before returning; returns `null` on any failure.

### `queryPerspectivePerformance(userId, limit?)`

- Computes per-perspective historical correctness from closed decisions and outcomes.
- Returns `null` when DB is unavailable (caller falls back to uniform weights).

### `recordGraphMemory(params)`

- Orchestrates inserting a decision node, signal nodes, asset node, and edges. Fire-and-forget in the agent layer.

---

## Data Models / Types

### `DecisionNode`

- `userId`, `asset`, `category`, `decision`, `side`, `confidence`, `tradePlan`, `timestamp`
- `perspectiveBreakdown?`: per-perspective verdict array

### `SignalNode`

- `factor`, `signalType`, `description`, `strength`, `timestamp`

### `OutcomeNode`

- `result`: `"profit" | "loss" | "breakeven" | "cancelled"`
- `pnlUsdc?`, `pnlPercent?`, `exitPrice?`, `exitReason?`, `timestamp`

### `GraphCollectionNames`

- `DECISIONS`, `SIGNALS`, `OUTCOMES`, `ASSETS`, `DD_REPORTS`, plus edge collections.

---

## Dependencies

- **External:** `arangojs`

---

## Notes / Edge Cases

- All graph-memory writes are non-blocking in the agent layer. Failures are logged, never fatal.
- The DD report cache is defensive: stale, corrupted, or schema-incompatible reports are rejected.

---

## Related Docs

- [Due Diligence Module](./due-diligence.md)
- [Planning Module](./planning.md)
- [Paper Trading Module](./paper-trading.md)
- [Deployment](../DEPLOYMENT.md)
