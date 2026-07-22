# Position Close Endpoints — Task List

**Plan:** `tasks/plan-close-positions.md`

---

## Phase 0: Foundation (Main Agent)

- [ ] **T0a:** Append `ClosePositionResult` and `CloseAllResult` types to `lib/agent/execution/types.ts`
- [ ] **T0b:** Create placeholder `lib/agent/execution/close.ts` with function stubs
- [ ] **T0c:** Create directories: `app/api/agent/execution/close/[coin]/`, `__tests__/lib/agent/execution/`, `__tests__/app/api/agent/execution/close/[coin]/`

**Verification:** Types compile. Stub exports correct signatures. Directories exist.
**Dependencies:** None

---

## Phase 1: Independent Modules (3 parallel subagents)

_(Each writes test first → implementation. All touch independent files.)_

### T1 — Close Logic Implementation

**Description:** Implement `closeAllPositions()` and `closePositionForCoin()` in `lib/agent/execution/close.ts`.

Flow per position:
1. Fetch `allMids()` for aggressive price
2. Resolve asset index + szDecimals via existing `getAssetIndex(coin)`
3. Cancel open orders for that coin via `InfoClient.openOrders` + `ExchangeClient.cancel`
4. Determine close side: `szi > 0` (long) → sell, `szi < 0` (short) → buy
5. Calculate aggressive price: sell → `mid × 0.99`, buy → `mid × 1.01`
6. Place reduceOnly IoC: `{ a: idx, b: closeSide, p: formatPrice(...), s: formatSize(abs(szi), ...), r: true, t: { limit: { tif: "Ioc" } } }`
7. Record outcome via `recordOutcome(decisionKey, { result: "cancelled", exitReason: "manual_close" })` — non-fatal

**Acceptance:**
- `closeAllPositions(agentPk, agentAddr)` with no positions → `{ closed: 0, positions: [] }`
- `closeAllPositions` with 1 long position → places sell IoC, cancels orders, returns `{ closed: 1 }`
- `closeAllPositions` with 1 short position → places buy IoC with correct side
- `closeAllPositions` with 2 positions → closes both, correct counts
- `closeAllPositions`: graph memory fails → log warn, still returns success
- `closePositionForCoin("BTC", ...)`: valid coin with position → closes only BTC
- `closePositionForCoin("XYZ", ...)`: no position → `{ closed: 0 }`
- Throws when `AGENT_PRIVATE_KEY` missing
- HL error → returns error per position, doesn't throw (keeps working on remaining)

**Files to modify:**
- `lib/agent/execution/close.ts` — from stub to full implementation

**Files to create:**
- `__tests__/lib/agent/execution/close.test.ts` — mock `@nktkas/hyperliquid`, `@/lib/agent/execution/client`, `@/lib/db/graph-memory`, `@/lib/utils`

**Verification:** `npx vitest run __tests__/lib/agent/execution/close.test.ts`
**Dependencies:** T0 (stub + types exist)

---

### T2 — Close-All API Route

**Description:** Create `POST /api/agent/execution/close` endpoint.

Route logic:
1. Check `AGENT_PRIVATE_KEY` + `AGENT_WALLET_ADDRESS` → 503 if missing
2. Call `closeAllPositions(agentPk, agentAddr)`
3. Return 200 with `CloseAllResult`
4. Return 502 on HL exchange error
5. Return 500 on unexpected error

**Acceptance:**
- POST with valid env vars, no positions → 200 `{ closed: 0, positions: [] }`
- POST with valid env vars, 1 position → 200 `{ closed: 1, positions: [{ coin: "BTC", ... }] }`
- POST with missing agent wallet → 503
- POST with HL error → 502
- POST with unexpected error → 500

**Files to create:**
- `app/api/agent/execution/close/route.ts`
- `__tests__/app/api/agent/execution/close/route.test.ts` — mock close module

**Verification:** `npx vitest run __tests__/app/api/agent/execution/close/route.test.ts`
**Dependencies:** T1 (closeAllPositions signature, mockable)

---

### T3 — Close-By-Coin API Route

**Description:** Create `POST /api/agent/execution/close/[coin]` endpoint.

Route logic:
1. Extract `coin` from Next.js dynamic route params
2. Check `AGENT_PRIVATE_KEY` + `AGENT_WALLET_ADDRESS` → 503
3. Validate coin param → 400 if missing
4. Validate coin exists in HL universe → 404 if not found
5. Call `closePositionForCoin(coin, agentPk, agentAddr)`
6. Return 200 with `CloseAllResult`

**Acceptance:**
- POST /close/BTC with position → 200 `{ closed: 1 }`
- POST /close/BTC with no position → 200 `{ closed: 0 }`
- POST /close/INVALID → 404
- POST with missing agent wallet → 503
- POST with HL error → 502

**Files to create:**
- `app/api/agent/execution/close/[coin]/route.ts`
- `__tests__/app/api/agent/execution/close/coin.test.ts` — mock close module

**Verification:** `npx vitest run __tests__/app/api/agent/execution/close/coin.test.ts`
**Dependencies:** T1 (closePositionForCoin signature, mockable)

---

### Checkpoint: Phase 1
- [ ] All 3 module test files pass
- [ ] Types compile without errors

---

## Phase 2: Finalize (Main Agent — sequential)

### T4 — Barrel Export

**Description:** Add close function exports to the agent pipeline barrel file.

**Acceptance:**
- `lib/agent/pipeline.ts` exports `closeAllPositions` and `closePositionForCoin`

**Files to modify:**
- `lib/agent/pipeline.ts` — APPEND `export { closeAllPositions, closePositionForCoin } from "./execution/close"`

**Verification:** `npx vitest run`
**Dependencies:** T1 (close.ts exists)

---

### T5 — API Documentation

**Description:** Document both close endpoints in `docs/api-documentation.md` following existing format.

**Acceptance:**
- Both endpoints documented with request/response examples, error codes, field descriptions

**Files to modify:**
- `docs/api-documentation.md` — APPEND after cancel endpoint docs

**Verification:** Manual review. `npx vitest run`
**Dependencies:** T2, T3 (routes exist)

---

## Phase 3: Verify (Main Agent)

- [ ] Run full test suite: `npm test`
- [ ] Run lint: `npm run lint`
- [ ] Run typecheck: `npm run typecheck`

**Final acceptance:**
- All tests pass (no skipped, no `.todo`)
- Zero TypeScript errors
- Zero lint errors
- Existing tests still pass (no regression — DD, Planning, Execution agents unaffected)
