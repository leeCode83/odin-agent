# Implementation Plan: Position Close Endpoints

**Spec:** Design interview (confirmed)
**Ref:** `docs/odin-spec.md` §4.3, `docs/api-documentation.md`

---

## Overview

Add two REST endpoints to close filled perpetual futures positions on Hyperliquid. The existing cancel endpoint (`POST /api/agent/execution/cancel`) only cancels resting open orders — it does not close filled positions. These new endpoints fill that gap.

| Endpoint | Behavior |
|----------|----------|
| `POST /api/agent/execution/close` | Close all filled positions across all coins |
| `POST /api/agent/execution/close/[coin]` | Close all filled positions for one coin |

Both endpoints cancel existing TP/SL orders for the target coin(s) first, then place `reduceOnly` IoC orders at an aggressive price (`mid × (1 ± 0.01)`) to force immediate fill. Closed positions are recorded to ArangoDB graph memory as outcome nodes (`result: "cancelled"`, `exitReason: "manual_close"`) — fire-and-forget, non-fatal.

Backend only. No frontend. No LLM calls — purely deterministic.

## Key Technical Decisions (from interview + context7 docs)

1. **Close method**: `reduceOnly` IoC limit order at aggressive price. Hyperliquid has no native market order; IoC with 1% price buffer is the standard simulation per SDK docs.
2. **Cancel first**: Before placing close orders, cancel all resting open orders for the target coin(s). Reuses existing `InfoClient.openOrders` + `ExchangeClient.cancel` pattern from `app/api/agent/execution/cancel/route.ts`.
3. **Size source**: `szi` (signed position size) from `InfoClient.clearinghouseState({ user })`. `szi > 0` = long → sell to close. `szi < 0` = short → buy to close.
4. **Graph recording**: Record `OutcomeNode` with `result: "cancelled"`, `exitReason: "manual_close"` via existing `recordOutcome()` in `lib/db/graph-memory.ts`. Fire-and-forget.
5. **Error handling**: Agent wallet not initialized → 503. HL exchange error → 502. No positions → 200 with `closed: 0`. Graph failure → log warn, continue.
6. **Test framework**: Vitest, same as rest of project. `vi.mock()` at module level. TDD (RED → GREEN → REFACTOR).
7. **Comment style**: JSDoc on every exported function, `@file` on new modules, inline comments for non-obvious logic. Match `lib/utils.ts` and `lib/agent/execution/pipeline.ts` patterns.
8. **No new dependencies** — reuses `@nktkas/hyperliquid`, `viem`, existing exports from `lib/agent/execution/client.ts`.

## Module Dependency Graph

```
lib/agent/execution/
  types.ts         ─── [APPEND] ClosePositionResult, CloseAllResult
  close.ts         ─── closeAllPositions(agentPk, agentAddr), closePositionForCoin(coin, agentPk, agentAddr)
  client.ts        ─── [NO CHANGE] reuse getAgentSigner, getExchangeClient, getAssetIndex

app/api/agent/execution/close/
  route.ts         ─── POST /api/agent/execution/close
  [coin]/
    route.ts       ─── POST /api/agent/execution/close/{coin}

lib/agent/pipeline.ts  ─── [APPEND] barrel export

docs/api-documentation.md ─── [APPEND] close endpoint documentation
```

## Implementation Flow (per endpoint request)

1. Validate agent wallet env vars (AGENT_PRIVATE_KEY, AGENT_WALLET_ADDRESS)
2. Fetch positions via `clearinghouseState({ user })`
3. Filter: `Math.abs(parseFloat(szi)) > 0`
4. For each position:
   a. Cancel open orders for that coin
   b. Fetch `allMids()` for aggressive price
   c. Determine close side: long → sell, short → buy
   d. Calculate aggressive close price: `mid * (1 ± tolerance)`
   e. Resolve asset index + szDecimals via `getAssetIndex(coin)`
   f. Place `reduceOnly` IoC order: `{ a: idx, b: closeSide, p: formatPrice(...), s: formatSize(abs(szi), ...), r: true, t: { limit: { tif: "Ioc" } } }`
5. Record `OutcomeNode` to graph memory (non-fatal)
6. Return `CloseAllResult` with per-coin status

## Architecture Decisions

1. **Types in existing file**: Append `ClosePositionResult` and `CloseAllResult` to `lib/agent/execution/types.ts` — same layer, same module.
2. **Close logic in new file**: `lib/agent/execution/close.ts` — clean separation from entry pipeline logic.
3. **Route split**: Two separate route files, no shared handler. Simpler, clearer, matches existing pattern.
4. **Cancel reuse**: `InfoClient.openOrders` + filter by coin → `ExchangeClient.cancel`. Same SDK calls as existing cancel route, just scoped per-coin.
5. **Barrel export**: Add to `lib/agent/pipeline.ts` — consistent with all other execution exports.

## Parallel Work Streams

### Phase 0: Foundation (Main Agent — sequential)
Create directories, append types, stub close.ts.

### Phase 1: Independent Modules (3 parallel subagents)
All independent — each writes test first then implementation.

- T1: Close logic (lib/agent/execution/close.ts) + unit tests
- T2: Close-all route (app/api/agent/execution/close/route.ts) + tests
- T3: Close-by-coin route (app/api/agent/execution/close/[coin]/route.ts) + tests

### Phase 2: Finalize (Main Agent — sequential)
Depends on Phase 1.

- T4: Update barrel export (lib/agent/pipeline.ts)
- T5: Update API docs (docs/api-documentation.md)

### Phase 3: Verify (Main Agent)
Run full test suite + lint + typecheck.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `allMids()` missing coin | Crash | Catch missing key, skip that coin with error in result |
| `szi` is "0" but order still showing | Unnecessary close attempt | Filter `szi === "0"` positions |
| Cancel fails | Close still runs but may conflict with TP/SL | Cancel is non-blocking — log warn, still place close |
| IoC partially fills | Position partially closed | Accept partial fill. `r: true` ensures no over-position. |
| ArangoDB unavailable | Outcome not recorded | Fire-and-forget — log error, continue |
