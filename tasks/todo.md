# Planning Agent — Task List

**Plan:** `tasks/plan.md`
**Spec:** `docs/planning-agent-spec.md` (Approved)

---

## Phase 0: Foundation (Main Agent)

- [ ] **T0:** Install dependency: `npm install arangojs`
- [ ] **T0b:** Create directories: `lib/agent/planning/`, `lib/db/`, `__tests__/lib/db/`, `__tests__/lib/agent/planning/`, `__tests__/app/api/agent/planning/`

**Verification:** `npm list arangojs` shows installed. Directories exist.
**Dependencies:** None

---

## Phase 1: Types Foundation (3 parallel subagents)

_(Each writes test first → implementation. All 3 touch independent files.)_

### T1 — Shared Inter-Agent Types

**Files:**
- `lib/agent/types.ts` — APPEND (preserve existing DD types): `Side`, `AutonomyDecision`, `ConfidenceBreakdown`, `GraphPattern`, `RiskThresholds`, `TradePlan` + all Zod schemas (`SideSchema`, `AutonomyDecisionSchema`, `ConfidenceBreakdownSchema`, `GraphPatternSchema`, `RiskThresholdsSchema`, `TradePlanSchema`)

**Acceptance:**
- `TradePlanSchema.parse(validTradePlan)` succeeds
- `TradePlanSchema.parse({...invalid})` throws
- Existing DD types/schemas untouched (DDReportSchema still works)
- All new types exported

**Files to create:**
- `__tests__/lib/agent/types.test.ts` — ADD tests for new schemas (don't break existing)

**Verification:** `npx vitest run __tests__/lib/agent/types.test.ts`
**Dependencies:** None (appends to existing file)

---

### T2 — ArangoDB Document Types

**Files:**
- `lib/db/arango-types.ts` — `DecisionNode`, `SignalNode`, `OutcomeNode`, `AssetNode`, `RiskThresholdsDoc`, `GraphMemoryEdge` + Zod schemas

**Acceptance:**
- `DecisionNode` type has: `_key`, `asset`, `category`, `decision`, `side`, `confidence`, `tradePlan`, `autonomyDecision`, `timestamp`
- `RiskThresholdsDoc` type has: `_key`, `userId`, `confidenceThreshold`, `maxPositionUsdc`, `maxLeverage`, `riskPerTradePercent`
- All doc types export Zod schemas for validation

**Files to create:**
- `lib/db/arango-types.ts`
- `__tests__/lib/db/arango-types.test.ts`

**Verification:** `npx vitest run __tests__/lib/db/arango-types.test.ts`
**Dependencies:** T1 (imports `Side`, `AutonomyDecision` from `@/lib/agent/types`)

---

### T3 — Planning-Internal Types

**Files:**
- `lib/agent/planning/types.ts` — `Perspective`, `PerspectiveResult`, `AggregatedReasoning`, `PlanningPipelineInput`, `PlanningPipelineOutput` + Zod schemas

**Acceptance:**
- `PlanningPipelineInput` has: `ddReport: DDReport`, `userId: string`, `walletAddress: string`
- `PlanningPipelineOutput` has: `tradePlan: TradePlan`, `timing: { totalMs }`
- `PerspectiveResult` has: `perspective`, `thesis`, `confidence`, `reasoningContent` (raw CoT)
- `Perspective` = `"conservative" | "balance" | "aggressive"`

**Files to create:**
- `lib/agent/planning/types.ts`
- `__tests__/lib/agent/planning/types.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/planning/types.test.ts`
**Dependencies:** T1 (imports `DDReport`, `TradePlan` from `@/lib/agent/types`)

---

## Phase 2: Implementation (6 parallel subagents)

_(Each writes test first → implementation. All modules independent at file level. Types from Phase 1 already exist.)_

### T4 — ArangoDB Client + Risk Thresholds + Graph Memory

**Files:**
- `lib/db/arango-client.ts` — `createArangoClient()`, `getDb()`, `getGraph()` singleton via arangojs. Reads `ARANGO_URL`, `ARANGO_DB`, `ARANGO_USER`, `ARANGO_PASSWORD` from env.
- `lib/db/risk-thresholds.ts` — `getRiskThresholds(userId: string): Promise<RiskThresholds>` — query `risk_thresholds` collection by userId, fallback to env defaults if not found / ArangoDB down.
- `lib/db/graph-memory.ts` — `queryGraphPatterns(asset: string, category: string): Promise<GraphPattern[]>` — AQL query traversing decision→asset→category→outcome edges, returns `{ pattern, outcome, frequency }`.

**Acceptance:**
- `createArangoClient()` returns `Database` instance from arangojs
- `getRiskThresholds("user-1")` returns env defaults when no ArangoDB record
- `getRiskThresholds("user-1")` returns stored values when record exists
- `queryGraphPatterns("BTC", "major")` returns `[]` when no matching decisions (cold start)
- ArangoDB unavailable → all functions return defaults (never throw)

**Files to create:**
- `lib/db/arango-client.ts`
- `lib/db/risk-thresholds.ts`
- `lib/db/graph-memory.ts`
- `__tests__/lib/db/arango-client.test.ts` — mock arangojs
- `__tests__/lib/db/risk-thresholds.test.ts` — mock arangojs + env
- `__tests__/lib/db/graph-memory.test.ts` — mock arangojs cursor

**Verification:** `npx vitest run __tests__/lib/db/`
**Dependencies:** T1 (imports `RiskThresholds`, `GraphPattern`), T2 (imports doc types)

---

### T5 — Hyperliquid SDK Extensions

**Files:**
- `lib/data/hyperliquid.ts` — ADD 3 functions:
  - `fetchMarkPrice(asset: string): Promise<number>` — via `client.info.allMids()` or `l2Book()`
  - `fetchUserEquity(walletAddress: string): Promise<number>` — via `client.info.userClearingState(walletAddress)` → crossMarginSummary → accountValue
  - `fetchCandlesForATR(asset: string, interval?: string, window?: number): Promise<CandleData[]>` — MODIFY existing `fetchCandles` to accept params OR add new function

**Acceptance:**
- `fetchMarkPrice("BTC")` returns number > 0
- `fetchUserEquity("0x...")` returns number >= 0
- `fetchCandlesForATR("BTC", "1h", 14)` returns CandleData[] for ATR period
- HL SDK mockable via `vi.mock("@nktkas/hyperliquid")`
- Existing HL functions untouched (fetchCandles, fetchOnchainData, fetchAllHLData)

**Files to create (tests):**
- `__tests__/lib/data/hyperliquid.test.ts` — ADD tests for new functions (don't break existing)
  - Make sure to read the full file first and ONLY add new test cases

**Verification:** `npx vitest run __tests__/lib/data/hyperliquid.test.ts`
**Dependencies:** None (uses existing createHLClient + CandleData type)

---

### T6 — Planning Agent Prompts

**Files:**
- `lib/agent/planning/prompts.ts` — 4 prompt exports:
  - `PERSPECTIVE_SYSTEM_PROMPTS: Record<Perspective, string>` — conservative/balance/aggressive
  - `AGGREGATOR_SYSTEM_PROMPT: string` — synthesize 3 perspectives
  - `PERSPECTIVE_USER_PROMPT(ddReport, graphPatterns): string` — dynamic user prompt template
  - `AGGREGATOR_USER_PROMPT(results): string` — dynamic aggregator input template

**Acceptance:**
- Each perspective prompt has distinct framing (conservative: risk-averse, balance: neutral, aggressive: opportunity-seeking)
- Prompts instruct LLM to output JSON matching spec structure (thesis, confidence, signals, side, leverage, reasoning)
- Aggregator prompt reconciles divergent perspectives
- All prompts exported as `const` strings (follow DD Agent pattern)

**Files to create:**
- `lib/agent/planning/prompts.ts`
- `__tests__/lib/agent/planning/prompts.test.ts` — test prompt structure, keyword checks per perspective

**Verification:** `npx vitest run __tests__/lib/agent/planning/prompts.test.ts`
**Dependencies:** T3 (imports `Perspective` type)

---

### T7 — Risk Engine (Deterministic Math)

**Files:**
- `lib/agent/planning/risk-engine.ts` — pure functions (no side effects):
  - `computeATR(candles: CandleData[], period: number): number` — Average True Range
  - `computeEntryPrice(asset: string): Promise<number>` — fetches mark price (delegates to fetchMarkPrice)
  - `computeSLTP(entry: number, atr: number, side: Side, slMultiplier?: number, tpMultiplier?: number): { stopLoss: number, takeProfit: number }` — ATR-based SL/TP
  - `computePositionSize(equity: number, entry: number, stopLoss: number, riskPercent: number): { positionSizeUsdc: number, positionSizeContracts: number }` — fixed-fractional
  - `capLeverage(llmSuggested: number, maxAllowed: number): number` — `min()`

**Acceptance:**
- `computeATR` with known candle data returns correct value
- Long SL = entry - ATR * slMult, Long TP = entry + ATR * tpMult (3:1 R:R default)
- Short SL/TP flipped
- `computePositionSize(10000, 100, 95, 1)` returns riskAmount = 100, contracts = 20
- `capLeverage(15, 10)` returns 10

**Files to create:**
- `lib/agent/planning/risk-engine.ts`
- `__tests__/lib/agent/planning/risk-engine.test.ts` — pure math, no mocks needed

**Verification:** `npx vitest run __tests__/lib/agent/planning/risk-engine.test.ts`
**Dependencies:** T1 (imports `Side`, `RiskThresholds`)

---

### T8 — Autonomy Gate

**Files:**
- `lib/agent/planning/gate.ts` — pure function:
  - `autonomyGate(confidence: number, positionSizeUsdc: number, thresholds: RiskThresholds): AutonomyDecision` — returns `"auto"` if `confidence >= thresholds.confidenceThreshold AND positionSizeUsdc <= thresholds.maxPositionUsdc`, else `"approve"`

**Acceptance:**
- confidence=80, size=50, threshold=70, max=100 → "auto"
- confidence=60, size=50, threshold=70, max=100 → "approve"
- confidence=80, size=150, threshold=70, max=100 → "approve"
- Both fail → "approve"

**Files to create:**
- `lib/agent/planning/gate.ts`
- `__tests__/lib/agent/planning/gate.test.ts` — table-driven test

**Verification:** `npx vitest run __tests__/lib/agent/planning/gate.test.ts`
**Dependencies:** T1 (imports `AutonomyDecision`, `RiskThresholds`)

---

### T9 — LLM Integration (DeepSeek Thinking Mode)

**Files:**
- `lib/agent/planning/llm.ts` — LLM call functions:
  - `createClient(): OpenAI` — singleton (follow DD pattern, but different model/reasoning config)
  - `generatePerspective(perspective: Perspective, ddReport: DDReport, graphPatterns: GraphPattern[]): Promise<PerspectiveResult>` — single thinking-mode call with perspective-specific prompt, parses JSON output, extracts `reasoning_content`
  - `aggregatePerspectives(results: PerspectiveResult[], ddReport: DDReport): Promise<AggregatedReasoning>` — aggregator thinking-mode call, synthesizes 3 perspectives into final thesis + confidence breakdown

**Acceptance:**
- Calls use `model: "deepseek-v4-flash"`, `thinking: {"type":"enabled"}`, `reasoning_effort: "high"`
- `generatePerspective` returns structured JSON parsed via Zod (`PerspectiveResultSchema`)
- JSON parse failure: retry once, then return null + error
- `reasoning_content` extracted and stored in `PerspectiveResult.reasoningContent`
- Each call has `withTimeout(30000)` + `withRetry(maxRetries=1)`

**Files to create:**
- `lib/agent/planning/llm.ts`
- `__tests__/lib/agent/planning/llm.test.ts` — mock OpenAI client

**Verification:** `npx vitest run __tests__/lib/agent/planning/llm.test.ts`
**Dependencies:** T3 (PerspectiveResult type), T6 (prompts), T1 (DDReport, GraphPattern)

---

## Phase 3: Pipeline Integration (Main Agent — sequential)

- [ ] **T10:** `lib/agent/planning/pipeline.ts` — `runPlanningPipeline(input: PlanningPipelineInput): Promise<PlanningPipelineOutput>`
  - Orchestrator: validate input → fetch equity (HL) → fetch candles (HL) → query graph (ArangoDB) → 3 parallel perspective LLM calls → 1 aggregator LLM call → risk engine (entry + SL/TP + size) → gate → return TradePlan + timing
  - Validate DDReport with DDReportSchema (existing)
  - 90s hard timeout with AbortController
  - Per-step try/catch with degradation (ArangoDB down → empty patterns, LLM fail → null perspective)
  - All 3 LLM perspectives fail → throw 500

- [ ] **T11:** `lib/agent/pipeline.ts` — ADD `export { runPlanningPipeline } from "./planning/pipeline"`

- [ ] **T12:** `app/api/agent/planning/route.ts` — `POST /api/agent/planning`
  - Input: `{ ddReport: DDReport, userId: string, walletAddress: string }`
  - Validate with Zod, return 400 on bad input
  - Call `runPlanningPipeline`, return 200 TradePlan
  - Catch errors, return 500 with error message

**Files to create:**
- `lib/agent/planning/pipeline.ts`
- `app/api/agent/planning/route.ts`
- `__tests__/lib/agent/planning/pipeline.test.ts` — mock all sub-modules
- `__tests__/app/api/agent/planning/route.test.ts` — mock pipeline

**Acceptance:**
- Full pipeline test with mocked deps returns valid TradePlan
- Route returns 400 for invalid input
- Route returns 200 + TradePlan for valid input
- Pipeline tracks timing per step (equityMs, candleMs, graphMs, llmMs, totalMs)

**Verification:** `npx vitest run __tests__/lib/agent/planning/pipeline.test.ts __tests__/app/api/agent/planning/route.test.ts`
**Dependencies:** ALL Phase 2 modules (T4-T9)

---

## Phase 4: Verify (Main Agent)

- [ ] Run full test suite: `npm test`
- [ ] Run lint: `npm run lint`
- [ ] Run typecheck: `npm run typecheck`

**Final acceptance:**
- All tests pass (no skipped, no `.todo`)
- Zero TypeScript errors
- Zero lint errors
- DD Agent tests still pass (no regression)
