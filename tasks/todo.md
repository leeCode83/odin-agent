# Execution Agent — Task List

**Plan:** `tasks/plan.md`
**Spec:** `docs/execution-agent-spec.md` (Approved)

---

## Phase 0: Foundation (Main Agent)

- [ ] **T0a:** Install dependency: `npm install viem`
- [ ] **T0b:** Create directories: `lib/agent/execution/`, `app/api/agent/execution/init/`, `app/api/agent/execution/cancel/`, `app/api/agent/execution/outcome/`, `app/api/agent/execution/status/`, `__tests__/lib/agent/execution/`, `__tests__/app/api/agent/execution/init/`

**Verification:** `npm list viem` shows installed. Directories exist.
**Dependencies:** None

---

## Phase 1: Independent Modules (5 parallel subagents — ≤6 limit)

_(Each writes test first → implementation. All 5 touch independent files.)_

### T1 — Graph Memory Write Functions

**Description:** Append 2 functions to existing `lib/db/graph-memory.ts`:
- `recordGraphMemory(params: GraphMemoryInput): Promise<string>` — orchestrates: find/create AssetNode → insert DecisionNode → batch insert SignalNodes (if signals provided) → insert edges (ANALYZED, TRIGGERED_BY) → return decisionKey
- `recordOutcome(decisionKey: string, outcome: OutcomeNode): Promise<void>` — upsert OutcomeNode + RESULTED_IN edge from decision to outcome

**Acceptance:**
- `recordGraphMemory({userId, asset, category, tradePlan, signals?})` inserts DecisionNode + edges, returns `_key`
- When signals[] provided, inserts SignalNodes + TRIGGERED_BY edges
- `recordOutcome("decisions/abc", {result:"profit", pnlUsdc:12.5})` upserts OutcomeNode + RESULTED_IN edge
- ArangoDB unavailable → log error, return empty string (never throw)
- Existing `queryGraphPatterns` function unchanged

**Files to create:**
- `__tests__/lib/db/graph-memory-writes.test.ts` — mock arangojs cursor + collection

**Files to modify:**
- `lib/db/graph-memory.ts` — APPEND new functions (preserve existing)

**Verification:** `npx vitest run __tests__/lib/db/graph-memory-writes.test.ts`
**Dependencies:** None (uses existing arango-types.ts types, arango-client.ts singleton)

---

### T2 — Execution Internal Types

**Description:** Create `lib/agent/execution/types.ts` with all execution-internal interfaces and Zod schemas:
- `OrderBuildResult` — entry order (IoC) + TP/SL trigger orders with grouping
- `ExecutionResult` — status enum ("placed" | "filled" | "partial" | "failed" | "cancelled"), orders[], groupId, fillStatus, fillAmount/Price, timestamp, decisionKey?
- `ExecutionPipelineInput` — tradePlan: TradePlan, walletAddress: string, userId: string, ddReport?: DDReport
- `ExecutionPipelineOutput` — execution: ExecutionResult, timing: { buildMs, placeMs, totalMs }
- `AgentInitResult` — agentAddress, agentPrivateKey, approved
- `OutcomeInput` — decisionKey, result, pnlUsdc?, pnlPercent?, exitPrice?, exitReason?
- `ExecutionError` — custom Error class

**Acceptance:**
- `ExecutionPipelineInput` has: tradePlan + walletAddress + userId + optional ddReport
- `ExecutionResult` status is `"placed" | "filled" | "partial" | "failed" | "cancelled"`
- `OutcomeInput` result is `"profit" | "loss" | "breakeven" | "cancelled"`
- All types exported
- `ExecutionError` extends Error with `this.name = "ExecutionError"`

**Files to create:**
- `lib/agent/execution/types.ts`
- `__tests__/lib/agent/execution/types.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/execution/types.test.ts`
**Dependencies:** T1 (imports TradePlan, DDReport from @/lib/agent/types)

---

### T3 — Exchange Client

**Description:** Create `lib/agent/execution/client.ts` with Hyperliquid exchange client factories:
- `isTestnet` — reads `HYPERLIQUID_TESTNET` env var (defaults to true)
- `privateKeyToAccount` / `generatePrivateKey` — via `viem/accounts`
- `getAgentSigner(privateKey: string): Account` — `privateKeyToAccount(pk)`
- `getExchangeClient(signer: Account): ExchangeClient` — `HttpTransport({ isTestnet })` + `new ExchangeClient({ transport, wallet: signer })`
- `getMasterSigner(): Account` — reads `MASTER_PRIVATE_KEY` from env
- `getMasterClient(): ExchangeClient` — convenience wrapper
- `generateAgentWallet(): { address, privateKey }` — generates fresh key
- `approveAgent(agentAddress, agentName): Promise<void>` — master client calls `approveAgent`

**Acceptance:**
- `getAgentSigner("0x...")` returns Account via viem
- `getExchangeClient(account)` returns ExchangeClient
- `getMasterSigner()` throws error with message when `MASTER_PRIVATE_KEY` not set
- `generateAgentWallet()` returns `{address, privateKey}` where both are 0x-prefixed
- `getMasterClient()` uses isTestnet config
- All viem/Hyperliquid calls mockable

**Files to create:**
- `lib/agent/execution/client.ts`
- `__tests__/lib/agent/execution/client.test.ts` — mock viem/accounts + @nktkas/hyperliquid

**Verification:** `npx vitest run __tests__/lib/agent/execution/client.test.ts`
**Dependencies:** None (standalone)

---

### T4 — Order Builder

**Description:** Create `lib/agent/execution/orders.ts` with:
- `buildOrders(tradePlan: TradePlan): OrderBuildResult` — translates TradePlan into Hyperliquid wire format:
  - Entry: limit IoC order at `entry_price`, side from tradePlan, size from `position_size_contracts`
  - TP: trigger order at `take_profit`, opposite side, `reduceOnly: true`, `grouping: "normalTpsl"`
  - SL: trigger order at `stop_loss`, opposite side, `reduceOnly: true`, `grouping: "normalTpsl"` (same grouping key as TP)

Wire format per spec §8.2:
- Entry: `{ a: asset, b: "B"|"A", p: price, s: size, r: false, t: { limit: { tif: "Ioc" } } }`
- TP/SL: `{ a: asset, b: opposite, p: triggerPx, s: size, r: true, t: { trigger: { isTrigger: true, triggerPx, triggerCondition: ">="|"<=" } }, grouping: "normalTpsl" }`

**Acceptance:**
- Long entry: side "B" (bid), TP above entry, SL below entry
- Short entry: side "A" (ask), TP below entry, SL above entry
- TP side is opposite of entry side (close position)
- SL side is opposite of entry side (close position)
- Both TP and SL have `reduceOnly: true`
- TP and SL share same `grouping: "normalTpsl"`
- Long SL trigger condition: `"<="`, TP trigger condition: `">="`
- Short SL trigger condition: `">="`, TP trigger condition: `"<="`

**Files to create:**
- `lib/agent/execution/orders.ts`
- `__tests__/lib/agent/execution/orders.test.ts` — pure function, no mocks needed

**Verification:** `npx vitest run __tests__/lib/agent/execution/orders.test.ts`
**Dependencies:** T1 (imports TradePlan from @/lib/agent/types), T2 (OrderBuildResult type)

---

### T5 — WebSocket Fill Monitor

**Description:** Create `lib/agent/execution/ws-monitor.ts` with:
- `subscribeFill(orderIds: number[], timeoutMs?: number): Promise<FillResult[]>` — WebSocket-based fill monitor:
  - Creates `SubscriptionClient` connected to HL testnet/mainnet WS
  - Listens on `orderUpdates` channel
  - Matches incoming updates by `oid`
  - Resolves when all orderIds have status "filled" or "canceled"
  - Timeout after `timeoutMs` (default 15,000ms) → returns whatever results collected so far
  - On error: close WS, return `status: "none"` for unfilled orders
- `FillResult` interface: `{ status: "filled" | "partial" | "none", fillAmount?: string, fillPrice?: string, oid: number }`
- `client.on("error", ...)` handling
- `client.unsubscribeAll()` + `client.close()` cleanup in all exit paths

**Acceptance:**
- Creates SubscriptionClient with correct WS URL (testnet/mainnet based on env)
- Listens on "orderUpdates" channel
- Detects "filled" status → returns FillResult with fillAmount + fillPrice
- Times out after configured ms → returns partial results
- Cleans up (unsubscribe + close) on completion
- Handles WS error gracefully → returns "none" status

**Files to create:**
- `lib/agent/execution/ws-monitor.ts`
- `__tests__/lib/agent/execution/ws-monitor.test.ts` — mock SubscriptionClient + event emitters

**Verification:** `npx vitest run __tests__/lib/agent/execution/ws-monitor.test.ts`
**Dependencies:** None (standalone)

---

### Checkpoint: Phase 1
- [ ] All 5 module test files pass
- [ ] Types compile without errors

---

## Phase 2: Pipeline Integration (Main Agent — sequential)

### T6 — Execution Pipeline

**Description:** Create `lib/agent/execution/pipeline.ts` with `runExecutionPipeline(input: ExecutionPipelineInput): Promise<ExecutionPipelineOutput>`:

Flow:
1. Validate TradePlan with `TradePlanSchema.parse`
2. Check `autonomy_decision === "auto"` → reject "approve" plans
3. Check `AGENT_PRIVATE_KEY` env var exists → throw if missing
4. Build orders via `buildOrders(validated)`
5. Get signer + exchange client
6. Set leverage via `client.updateLeverage`
7. Place orders via `client.order()` — single call with entry + TP/SL
8. Subscribe fill via `ws-monitor.subscribeFill(orderIds)`
9. Record to graph memory (if ddReport provided): extract signals from ddReport sections, call `recordGraphMemory`
10. Return ExecutionResult + timing

Error handling:
- Missing agent key → `ExecutionError("Agent wallet not initialized...")`
- Leverage fails → `ExecutionError("HL exchange error (leverage)")`
- Order placement fails → `ExecutionError("HL exchange error")`
- Graph recording fails → log warning, continue (non-fatal)

Also update `lib/agent/pipeline.ts` to export `runExecutionPipeline`.

**Files to create:**
- `lib/agent/execution/pipeline.ts`
- `__tests__/lib/agent/execution/pipeline.test.ts` — mock client, orders, ws-monitor, graph-memory

**Files to modify:**
- `lib/agent/pipeline.ts` — ADD `export { runExecutionPipeline } from "./execution/pipeline"`

**Verification:** `npx vitest run __tests__/lib/agent/execution/pipeline.test.ts`
**Dependencies:** T1 (graph-memory writes), T2 (types), T3 (client), T4 (orders), T5 (ws-monitor)

---

### T7 — API Routes

**Description:** Create 5 API route files following pattern from `app/api/agent/planning/route.ts`:

1. **`POST /api/agent/execution`** (route.ts)
   - Input: `{ tradePlan, walletAddress, userId, ddReport? }`
   - Validate presence of tradePlan + walletAddress (400 if missing)
   - Validate tradePlan with TradePlanSchema (400 if invalid)
   - Call `runExecutionPipeline(input)`
   - Return 200 with execution result + timing
   - Return 503 if agent wallet not initialized
   - Return 502 on HL exchange error

2. **`POST /api/agent/execution/init`** (init/route.ts)
   - Input: `{ agentName }`
   - Check MASTER_PRIVATE_KEY env var (400 if missing)
   - Call `generateAgentWallet()` + `approveAgent(agentAddress, agentName)`
   - Return 200 with agentAddress + agentPrivateKey + approved

3. **`POST /api/agent/execution/cancel`** (cancel/route.ts)
   - No body required
   - Get agent signer + exchange client
   - Call HL cancel endpoint for all orders
   - Return 200 with cancelled count

4. **`POST /api/agent/execution/outcome`** (outcome/route.ts)
   - Input: `{ decisionKey, result, pnlUsdc?, pnlPercent?, exitPrice?, exitReason? }`
   - Validate input (400 if invalid)
   - Call `recordOutcome(decisionKey, outcome)`
   - Return 200 with recorded status

5. **`GET /api/agent/execution/status`** (status/route.ts)
   - Query param: `oid`
   - Create info client, query order status
   - Return 200 with order status

**Files to create:**
- `app/api/agent/execution/route.ts`
- `app/api/agent/execution/init/route.ts`
- `app/api/agent/execution/cancel/route.ts`
- `app/api/agent/execution/outcome/route.ts`
- `app/api/agent/execution/status/route.ts`
- `__tests__/app/api/agent/execution/route.test.ts` — mock pipeline
- `__tests__/app/api/agent/execution/init/route.test.ts` — mock client

**Verification:** `npx vitest run __tests__/app/api/agent/execution/`
**Dependencies:** T6 (pipeline), T3 (client)

---

## Phase 3: Verify (Main Agent)

- [ ] Run full test suite: `npm test`
- [ ] Run lint: `npm run lint`
- [ ] Run typecheck: `npm run typecheck`

**Final acceptance:**
- All tests pass (no skipped, no `.todo`)
- Zero TypeScript errors
- Zero lint errors
- Planning Agent + DD Agent tests still pass (no regression)
