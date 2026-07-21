# Implementation Plan: Execution Agent

**Spec:** `docs/execution-agent-spec.md` (Approved)
**Ref:** `docs/odin-spec.md` §4.3
**Pattern to mirror:** `docs/planning-agent-spec.md` → `tasks/plan.md` (Planning Agent done)

---

## Overview

Build Execution Agent — third and final agent in Odin's 3-agent pipeline. Purely deterministic (no LLM calls). Takes a `TradePlan` from Planning Agent, builds entry + OCO TP/SL orders, signs and places on Hyperliquid testnet via `@nktkas/hyperliquid` SDK, monitors fill via WebSocket, records execution to ArangoDB graph memory, and returns execution result. Includes one-time agent wallet setup, emergency cancel-all, and trade outcome recording.

Pipeline: validate TradePlan → check autonomy decision → build entry (IoC) + OCO TP/SL orders → get agent signer → set leverage → place orders → monitor fill (WS + polling fallback) → record to graph memory (decision + signals + edges) → return execution result.

Backend only. No frontend. Deterministic — no LLM calls in Execution Agent.

## Key Technical Decisions (from spec + interview)

1. **Agent wallet model**: Auto-generate private key + SDK `approveAgent()`. Key saved to `.env`. Master key only used for approve (init only). Trade-only permissions — cannot withdraw.
2. **Entry order type**: Limit IoC (Immediate-or-Cancel) — simulated market order. Fills immediately at limit price, cancels unfilled remainder.
3. **TP/SL**: OCO (One-Cancels-Other) via `grouping: "normalTpsl"` — one triggers, other auto-cancels. Both `reduceOnly: true`.
4. **Fill monitoring**: WebSocket `SubscriptionClient` on `orderUpdates` channel. 15s timeout. Fallback: poll `GET /status?oid=` every 2s.
5. **Graph memory recording**: Final step after order placement (fire-and-forget). Non-blocking — execution succeeds regardless of DB write outcome.
6. **Signal recording**: `ddReport` is optional input to execution pipeline. If provided, signals from DD sections are extracted and recorded as SignalNodes in ArangoDB. If absent, only DecisionNode + AssetNode are recorded.
7. **Trade outcome**: Separate `POST /api/agent/execution/outcome` endpoint — accepts `decisionKey` + `result` + PnL data, upserts OutcomeNode + RESULTED_IN edge.
8. **No position management**: Place order regardless of existing positions. User may hedge. Spec explicitly excludes position management in MVP.
9. **`viem` dependency**: Needed for `privateKeyToAccount` and `generatePrivateKey`. `@nktkas/hyperliquid` already in package.json.

## Module Dependency Graph

```
lib/agent/execution/
  types.ts           ─── ExecutionPipelineInput/Output, OrderBuildResult
  client.ts          ─── getAgentSigner, getExchangeClient, generateAgentWallet, approveAgent
  orders.ts          ─── buildOrders(tradePlan) → entry + OCO TP/SL wire format
  ws-monitor.ts      ─── subscribeFill(orderIds, timeout) → WS → polling fallback
  pipeline.ts        ─── runExecutionPipeline(input) orchestrator

lib/db/graph-memory.ts ─── [APPEND] recordGraphMemory, recordOutcome
  (dep: arango-types.ts DecisionNode, SignalNode, OutcomeNode)

app/api/agent/execution/
  route.ts          ─── POST /api/agent/execution
  init/route.ts     ─── POST /api/agent/execution/init
  cancel/route.ts   ─── POST /api/agent/execution/cancel
  outcome/route.ts  ─── POST /api/agent/execution/outcome
  status/route.ts   ─── GET /api/agent/execution/status?oid=
```

```
lib/agent/pipeline.ts ─── [MODIFY] add barrel export
```

## Architecture Decisions

1. **Types split**: Shared inter-agent types (TradePlan, DDReport) → `lib/agent/types.ts` (existing, read-only consumer). Execution-internal types (ExecutionPipelineInput, OrderBuildResult, ExecutionResult) → `lib/agent/execution/types.ts`. Following existing Planning Agent pattern.
2. **Graph memory writes**: Append to existing `lib/db/graph-memory.ts` — same file as `queryGraphPatterns` (read). New functions: `recordGraphMemory(params)` (transactional insert of decision + signals + edges) and `recordOutcome(decisionKey, outcome)` (upsert outcome + edge).
3. **Test framework**: Vitest (same as Planning Agent). `vi.mock()` at module level for `@nktkas/hyperliquid`, `arangojs`, `viem/accounts`.
4. **TDD per file**: Each subagent writes failing test (RED) → minimal implementation (GREEN) → verify.
5. **Error pattern**: Every module throws typed `ExecutionError`; pipeline catches. Graph DB unavailable → log warning, skip recording (non-fatal). HL exchange down → retry 2× with backoff, then throw. Missing agent key → throw (fatal — init required).
6. **New dependency**: `viem` (`npm install viem`).

## Parallel Work Streams

### Phase 0: Foundation (Main Agent — sequential)
Install viem, create directories.

### Phase 1: Independent Modules (5 parallel subagents)
All independent — each writes test first then implementation.

- T1: Graph memory writes (lib/db/graph-memory.ts append) + tests
- T2: Execution types (lib/agent/execution/types.ts) + tests
- T3: Exchange client (lib/agent/execution/client.ts) + tests
- T4: Order builder (lib/agent/execution/orders.ts) + tests
- T5: WebSocket monitor (lib/agent/execution/ws-monitor.ts) + tests

### Phase 2: Pipeline Integration (Main Agent — sequential)
Depends on all Phase 1 modules.

- T6: Execution pipeline (lib/agent/execution/pipeline.ts) + barrel export + tests
- T7: 5 API routes + tests

### Phase 3: Verify (Main Agent)
Run full test suite + lint + typecheck.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| @nktkas/hyperliquid SDK v0.33.2 API mismatch | Orders wire format wrong | Use spec code as reference, verify via tests. Mock SDK in unit tests. |
| WebSocket unavailable in CI | WS monitor tests hang | Mock SubscriptionClient. Test WS connection logic separately from fill detection. |
| ArangoDB not installed locally | Graph memory tests fail | Mock arangojs in all tests. Record functions return early if DB unavailable. |
| viem API changes (privateKeyToAccount) | Client creation fails | Pin viem version. Mock in tests. |
| Zod v4 z.record() 2-arg requirement | Schema breaks | Already handled in Planning Agent. Follow same pattern. |
| Agent wallet init requires master key | Init endpoint fails in CI | Test init route with mocked client. Real approval only needs manual test. |
