# Planning Agent Refactor — Task List

**Plan:** `tasks/plan.md`
**Spec:** `docs/refactor/planning-spec.md`
**Previous pattern:** `tasks/todo.md` (DD Agent Refactor)

Documentation rule: Every file, function, interface, and inline logic gets JSDoc (`@function`, `@param`, `@returns`, `@description`) or inline `// reason:` comment. Follow existing pattern in `lib/data/hyperliquid.ts`, `lib/agent/due-diligence/agent.ts`.

TDD rule: Write failing test first (RED) → verify failure → minimal implementation (GREEN) → verify pass → refactor. No production code without a failing test first.

---

## Phase 0: Foundation (Main Agent)

### T0 — Create directories + env keys

**Description:** Create planning tool layer directories and register new env keys. No npm installs needed (technicalindicators already installed; Exa uses plain fetch).

**Files to create:**

- `lib/agent/planning/tools/` (dir)
- `__tests__/lib/agent/planning/tools/` (dir)

**Files to modify:**

- `.env.example` — add `DEEPSEEK_THINK_MODEL=deepseek-v4-pro` (orchestrator/aggregator, thinking mode) and `EXA_API_KEY=` (optional, web search)

**Verification:** Directories exist. `.env.example` shows both keys.
**Dependencies:** None

- [ ] Create both directories
- [ ] Update `.env.example`
- [ ] `npm run typecheck` still clean

---

## Phase 1: Types & Tools (3 parallel subagents)

### T1 — Types: PerspectiveReport + TradePlan.action + SubAgentThought extension

**Description:** Add planning swarm types, extend `TradePlanSchema` with `action`, extend `SubAgentThoughtSchema` return variant with optional planning fields. Critical for capture: zod strips unknown keys, so the planning wrapper can only receive `side`/`suggested_*` if the schema declares them.

**Acceptance:**

- `lib/agent/planning/types.ts` ADDS:
  - `PerspectiveReportSchema` + `PerspectiveReport` — `perspective` (PerspectiveSchema), `score` (number|null), `confidence` (number|null), `side` ("long"|"short"|"no_trade"), `entry_price` (number), `signals` (SignalEntry[]), `dataSources` (string[]), `reasoning` (string), `iterations` (number), `conclusion` (string), `errors` (string[]), `suggested_stop_loss`/`suggested_take_profit`/`suggested_leverage`/`suggested_position_size_usdc` (numbers), `risk_flags` (string[])
  - `PlanningSubagentPlan` — `{ perspective: Perspective, instruction: string, priority: number }`
  - `PlanningAgentPlan` — `{ subagents: PlanningSubagentPlan[], reDeployHistory: ReDeployEntry[] }`
  - `ReDeployEntry` — `{ perspective: string, previousConfidence: number | null, newInstruction: string, iteration: number }`
  - `ConsensusResult` — `{ decision: "ACCEPT" | "RE-DEPLOY" | "NO_TRADE" | "FAILED", lowConsensusPerspectives: string[], contradictions: string[], message: string, noTradeReason?: string }`
  - `PlanningAgentInput` — `{ asset: string, userId: string, walletAddress: string, targetProfitPercent: number }`
  - `PlanningAgentOutput` — `{ report: TradePlan, timing: { ddMs, planMs, executeMs, aggregateMs, evaluateMs, totalMs }, iterations: number, status: "complete" | "no_trade" | "partial" | "failed" }`
  - `PlanningAggregationResult` — `AggregatedReasoning` + `consensus_alignment` (number), `contradictions` (string[]), `profit_feasible` (boolean), `no_trade_reason?` (string), `side` widened to `"long" | "short" | "no_trade"`, adds `entry_price`, `stop_loss`, `take_profit`, `position_size_usdc`
- KEEP `PerspectiveSchema`. Mark `PerspectiveResult`, `PlanningPipelineInput`, `AggregatedReasoning` with `@deprecated` JSDoc (deleted in T10).
- `lib/agent/types.ts` `TradePlanSchema` adds: `action: z.enum(["LONG", "SHORT", "NO_TRADE"]).default("LONG")`, `consensus_alignment: z.number().min(0).max(100).optional()`, `processingTimeMs: z.number().optional()`, `iterations: z.number().optional()`
- `lib/agent/due-diligence/subagent.ts` `SubAgentThoughtSchema` return variant ADDS optional: `side: z.enum(["long","short","no_trade"]).optional()`, `entry_price`, `suggested_stop_loss`, `suggested_take_profit`, `suggested_leverage`, `suggested_position_size_usdc` (all `z.number().optional()`), `risk_flags: z.array(z.string()).optional()`. No other changes to the file.

**Files to modify:**

- `lib/agent/planning/types.ts`
- `lib/agent/types.ts`
- `lib/agent/due-diligence/subagent.ts` (schema only)

**Files to create:**

- `__tests__/lib/agent/planning/types.test.ts` (extend)
- `__tests__/lib/agent/due-diligence/subagent.test.ts` (extend — extras pass through, DD paths unchanged)

**Verification:** `npx vitest run __tests__/lib/agent/planning/types.test.ts __tests__/lib/agent/due-diligence/` then `npm run typecheck`
**Dependencies:** T0

- [ ] PerspectiveReport + PlanningAggregationResult + ConsensusResult + agent input/output types + tests
- [ ] TradePlanSchema: action + 3 optional fields + tests (old shape still parses, action defaults "LONG")
- [ ] SubAgentThoughtSchema: optional planning fields + tests (DD return path unchanged)
- [ ] Run full `__tests__/lib/agent/due-diligence/` — zero regressions

---

### T2 — Risk engine + market data tools

**Description:** Wrap `lib/agent/planning/risk-engine.ts` functions and existing data fetchers as `ToolDefinition`s. Deterministic, pure — no LLM.

**Acceptance:**

- `lib/agent/planning/tools/risk-engine.ts`:
  - `compute_atr` `{ asset, period? }` → `{ atr, atrPercentOfEntry, source: "hyperliquid" }` — `fetchCandlesForATR(asset, "1h", 20)` + `computeATR(candles, period ?? 14)` + `fetchMarkPrice(asset)`
  - `compute_sltp` `{ entry, atr, side, slMultiplier?, tpMultiplier? }` → `{ stopLoss, takeProfit }` — `computeSLTP(entry, atr, side, { slMultiplier: slMultiplier ?? 1.5, tpMultiplier: tpMultiplier ?? 3.0 })`
  - `compute_position_size` `{ equity, entry, stopLoss, riskPercent }` → `{ positionSizeUsdc, positionSizeContracts }` — `computePositionSize(...)`
  - `cap_leverage` `{ llmSuggested, maxAllowed }` → `{ leverage }` — `capLeverage(...)`
- `lib/agent/planning/tools/market-data.ts`:
  - `get_mark_price` `{ asset }` → `{ markPrice }` (`fetchMarkPrice`)
  - `get_candles` `{ asset, interval?, count? }` → `{ candles }` (`fetchCandlesForATR`)
  - `get_risk_thresholds` `{ userId }` → `{ thresholds }` (`getRiskThresholds(userId) ?? envDefaults()`)
  - `get_graph_patterns` `{ asset, category?, signals? }` → `{ patterns }` (`queryGraphPatterns`, errors → `success: false`)
  - `get_orderbook_depth` — re-export the existing `getOrderbookDepthTool()` from `lib/agent/tools/onchain/hyperliquid.ts` (no rewrite)
  - NO `get_equity` tool (resolved §16.4) — orchestrator pre-fetches equity once via `fetchUserEquity(walletAddress)` and passes it through ctx
- `lib/agent/planning/tools/index.ts`: `buildPlanningToolRegistry(ctx: { walletAddress: string, userId: string, asset: string, equity: number })` → `ToolRegistry` merging risk-engine + market-data + funding + liquidation + web-search registries. Candle fetches use `ctx.asset` when params omit it.
- All tools: Zod params (`.describe()` each), errors → `{ success: false, error }`, `metadata.source` set.

**Files to create:**

- `lib/agent/planning/tools/risk-engine.ts`
- `lib/agent/planning/tools/market-data.ts`
- `lib/agent/planning/tools/index.ts` (stub funding/liquidation/web-search imports after T3 lands)
- `__tests__/lib/agent/planning/tools/risk-engine.test.ts`
- `__tests__/lib/agent/planning/tools/market-data.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/planning/tools/`
**Dependencies:** T0 (T1 types optional here — tools only need `ToolDefinition`)

- [ ] risk-engine.ts: 4 tools + tests (mock candles/price, verify ATR/SLTP/size math)
- [ ] market-data.ts: 5 tools (no get_equity) + tests (mock fetchers, error paths → success:false)
- [ ] index.ts: buildPlanningToolRegistry merges all + test (ctx includes equity)

---

### T3 — Vibe + web search tools

**Description:** Funding regime, OI/funding divergence, liquidation approximation, Exa web search. Vibe tools derive from `lib/agent/skills/perp-funding-basis` + `liquidation-heatmap` methodology but use only HL public data (honest approximation — HL exposes no liquidation heatmap).

**Acceptance:**

- `lib/agent/planning/tools/funding.ts`:
  - `analyze_funding_regime` `{ asset }` → `{ regime: "normal" | "overheated_long" | "overheated_short", fundingRate, openInterest, markPrice, predictedFunding?, notes }` — deterministic: `|fundingRate| > 0.05%` → overheated (long if positive). Data via `fetchOnchainData`/`fetchMarkPrice` from `lib/data/hyperliquid.ts`; predicted funding included from `predictedFundings` endpoint (`HlPerp` venue, first perp dex only) when available (resolved §16.3). Description text says "approx — HL funding snapshot".
  - `detect_oi_funding_divergence` `{ asset }` → `{ divergence: boolean, priceChangePct, oiChangePct, fundingRate, signal: "bullish" | "bearish" | "neutral", notes }` — price up + OI up + funding strongly positive → neutral/overextended; price up + funding negative → divergence flagged.
- `lib/agent/planning/tools/liquidation.ts`:
  - `check_liquidation_zones` `{ asset, entryPrice, stopLoss }` → `{ warning: boolean, zones: Array<{ price, label }>, notes }` — approximation: nearest bid/ask clusters from `getOrderbookDepthTool` as proxy for magnet zones; flags when `stopLoss` sits within 0.5% of a cluster.
  - `assess_cascade_risk` `{ asset }` → `{ cascadeRisk: "low" | "medium" | "high", notes }` — approximation: combines funding magnitude + OI + orderbook thinness. Label "approximation" in description AND result `notes`.
- `lib/agent/planning/tools/web-search.ts`:
  - `web_search` `{ query }` → `{ results: Array<{ title, url, text }> }` — POST `https://api.exa.ai/search` with `{ query, numResults: 5 }`, header `Authorization: Bearer ${process.env.EXA_API_KEY}`, 15s timeout. Missing key → `{ success: false, error: "EXA_API_KEY not configured" }` (fast, non-fatal).

**Files to create:**

- `lib/agent/planning/tools/funding.ts`
- `lib/agent/planning/tools/liquidation.ts`
- `lib/agent/planning/tools/web-search.ts`
- `__tests__/lib/agent/planning/tools/funding.test.ts`
- `__tests__/lib/agent/planning/tools/liquidation.test.ts`
- `__tests__/lib/agent/planning/tools/web-search.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/planning/tools/`
**Dependencies:** T0

- [ ] funding.ts: 2 tools + threshold tests (mock onchain data)
- [ ] liquidation.ts: 2 tools + tests (mock orderbook, cluster proximity)
- [ ] web-search.ts: tool + tests (mock fetch; key-missing path returns success:false)

---

## Phase 2: Subagent + Evaluation (2 parallel subagents)

### T4 — Perspective subagent wrapper + LLM + prompts

**Description:** Thin wrapper around DD `runSubagent()` + planning LLM functions (`plan`/`rePlan`/`aggregate`, deepseek-v4-pro thinking) + prompts (spec §7.2-7.4). NO new loop code.

**Acceptance:**

- `lib/agent/planning/subagent.ts`:
  - `runPerspectiveSubagent({ perspective, instruction, asset, ddReport, targetProfitPercent, tools })` → `Promise<PerspectiveReport>`
  - `llmThink`: closure — calls DD `think()` (from `@/lib/agent/due-diligence/llm`), if result `action === "return"` stashes it; returns result to `runSubagent` unchanged.
  - `getSystemPrompt`: `makePlanningSystemPrompt({ targetProfitPercent })(perspective, tools, instruction)`
  - `runSubagent({ factor: perspective, tools, instruction, asset, maxLoops: 5, timeoutMs: 60000, llmThink, getSystemPrompt })`
  - Mapping: `side: stash?.side ?? "no_trade"`, `entry_price: stash?.entry_price ?? 0`, `suggested_*: stash?.suggested_* ?? 0`, `risk_flags: stash?.risk_flags ?? []`, rest copied from returned `FactorReport`.
- `lib/agent/planning/llm.ts` ADDS (old `generatePerspective`/`aggregatePerspectives` KEPT, `@deprecated`):
  - `plan({ ddReport, targetProfitPercent })` → `Promise<PlanningSubagentPlan[]>` — model `DEEPSEEK_THINK_MODEL` (default `deepseek-v4-pro`), thinking mode (NO temperature param; `reasoning_effort` from `DEEPSEEK_REASONING_EFFORT`), `json_object`, `max_tokens: 8192`, timeout 60s, retry 1. Failure/parse error → `[]` + console.error. Sanitize: only 3 perspectives, dedupe, priority 1-3.
  - `rePlan({ ddReport, targetProfitPercent, lowConsensusPerspectives, previousReports })` → `Promise<PlanningSubagentPlan[]>` — same model config.
  - `aggregate({ reports, ddReport, targetProfitPercent })` → `Promise<PlanningAggregationResult | null>` — same model config; null on failure. Sanitize against `PlanningAggregationResult` (numbers clamped 0-100, `side` enum).
- `lib/agent/planning/prompts.ts` ADDS (old prompts KEPT until T10):
  - `makePlanningSystemPrompt({ targetProfitPercent })` → `(factor, tools, instruction) => string` — spec §7.2: perspective analyst persona, "do NOT re-analyze technical indicators (DDReport already did)", tasks 1-4, tool list via `describeZodSchema` (import from DD prompts), return format incl. `side`, `entry_price`, `suggested_*`, `risk_flags`. Requires: "Use at least 2 tools before returning."
  - `PLAN_PROMPT` (spec §7.3), `AGGREGATE_PROMPT` (spec §7.4 incl. "If 2+ perspectives conclude no_trade, final action is no_trade" + `profit_feasible` + `no_trade_reason`), `REPLAN_PROMPT` (targeted new instructions for low-consensus perspectives, past reports included).

**Files to create:**

- `lib/agent/planning/subagent.ts`
- `__tests__/lib/agent/planning/subagent.test.ts`

**Files to modify:**

- `lib/agent/planning/llm.ts`
- `lib/agent/planning/prompts.ts`
- `__tests__/lib/agent/planning/llm.test.ts` (extend)
- `__tests__/lib/agent/planning/prompts.test.ts` (extend)

**Verification:** `npx vitest run __tests__/lib/agent/planning/subagent.test.ts __tests__/lib/agent/planning/llm.test.ts __tests__/lib/agent/planning/prompts.test.ts`
**Dependencies:** T1, T2, T3

- [ ] subagent.ts wrapper: maps FactorReport + stashed extras + tests (mock llmThink: tool_call loop, return with extras, no stash → defaults)
- [ ] llm.ts: plan() sanitizes 3 perspectives + tests
- [ ] llm.ts: rePlan() targeted instructions + tests
- [ ] llm.ts: aggregate() sanitizes result, null on failure + tests
- [ ] prompts.ts: 4 prompt builders/constants render targetProfitPercent + tool descriptions + tests

---

### T5 — Consensus evaluation + circuit breaker + logging

**Description:** Deterministic Layer 1 evaluation (spec §8.1), in-memory circuit breaker (§9.7), leveled logging (§9.8).

**Acceptance:**

- `lib/agent/planning/evaluate.ts` — `evaluateConsensus(reports: PerspectiveReport[], aggregation: PlanningAggregationResult | null)` → `ConsensusResult`. Decision rules, FIRST MATCH WINS:
  1. All 3 reports `score === null` (failed) → `FAILED`
  2. ≥2 reports `side === "no_trade"` → `NO_TRADE` (noTradeReason from aggregation?.no_trade_reason)
  3. ≥2 reports' `risk_flags` joined-lowercase contain "funding" → `NO_TRADE` (overheating, spec §8.1 row 6)
  4. All 3 same side (long/short) AND aggregation.confidence_score >= 60 AND profit_feasible === true → `ACCEPT`
  5. 2/3 same side AND aggregation.confidence_score >= 50 → `ACCEPT`
  6. Aggregation confidence < 50 OR 1-2 disagree → `RE-DEPLOY` (lowConsensusPerspectives = disagreeing/low-confidence)
  7. Else → `RE-DEPLOY` (fallback, message explains)
- `lib/agent/planning/circuit-breaker.ts` — class `PlanningCircuitBreaker` (module singleton):
  - `recordDDFailure()` / `isDDPanicked()`: ≥3 DD failures within 5 min → reject 60 s (window slides by timestamps)
  - `recordLLMFailure()` / `isLLMPanicked()`: ≥5 LLM failures within 10 min → reject 120 s
  - `reset()` for tests. In-memory only (§9.7).
- `lib/agent/planning/log.ts` — `log(level: "debug" | "info" | "warn" | "error", event: string, data?: Record<string, unknown>)` — console; DEBUG only when `NODE_ENV === "development"`. Event names per spec §9.8 table.

**Files to create:**

- `lib/agent/planning/evaluate.ts`
- `lib/agent/planning/circuit-breaker.ts`
- `lib/agent/planning/log.ts`
- `__tests__/lib/agent/planning/evaluate.test.ts`
- `__tests__/lib/agent/planning/circuit-breaker.test.ts`
- `__tests__/lib/agent/planning/log.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/planning/evaluate.test.ts __tests__/lib/agent/planning/circuit-breaker.test.ts __tests__/lib/agent/planning/log.test.ts`
**Dependencies:** T1

- [ ] evaluateConsensus: all 7 rule branches + tests (first-match ordering asserted)
- [ ] circuit-breaker: window slide + reject/accept + tests (vi.useFakeTimers)
- [ ] log.ts: level gating + event payload + tests (spy console)

---

## Phase 3: Orchestrator (2 sequential subagents)

### T6 — Main agent runPlanningAgent()

**Description:** Plan-Execute-Reflect orchestrator. Mirrors `runDDAgent()` loop structure (see `lib/agent/due-diligence/agent.ts:149-288`).

**Acceptance:**

- `runPlanningAgent(params: PlanningAgentInput)` → `PlanningAgentOutput`
- Step 0: `const category = getCategory(params.asset)` (from `@/lib/asset-categories`); missing → throw `PlanningError("Unknown asset")`. `ddReport = await runDDAgent({ asset, category, userId, walletAddress })`; failure → throw `PlanningError("PLANNING_FAILED")` with `phase: "dd"` detail. **Equity pre-fetch** (resolved §16.4): `equity = await fetchUserEquity(walletAddress).catch(() => 0)` once, before the loop — used for tool registry ctx + position sizing.
- Loop (max 5):
  1. **PLAN:** first iteration `plan({ ddReport, targetProfitPercent })`; empty result → fallback = all 3 perspectives with generic instruction. Later iterations: `rePlan(...)` for `lowConsensusPerspectives` only.
  2. **EXECUTE:** `Promise.all` over planned perspectives → `runPerspectiveSubagent(...)` with `buildPlanningToolRegistry({ walletAddress, userId, asset, equity })`. Map-dedupe reports per perspective (pattern: agent.ts:193-196).
  3. **AGGREGATE:** `aggregate({ reports, ddReport, targetProfitPercent })`; null → keep previous, record error, `profit_feasible: false` fallback context.
  4. **EVALUATE:** `evaluateConsensus(reports, aggregation)`.
  5. ACCEPT → break. NO_TRADE → build plan `action: "NO_TRADE"`, return. FAILED → throw `PlanningError("PLANNING_FAILED")` (reports in detail). RE-DEPLOY → count per perspective; `reDeployCounts[p] >= 2` → force ACCEPT (best available, spec §8.1 last row); else continue loop. Loop exhausted without ACCEPT → status `"partial"`, best-effort plan.
- Layer 2 (ACCEPT): `thresholds = await getRiskThresholds(userId)` (fallback `envDefaults()`), `autonomyGate(aggregation.confidence_score, aggregation.position_size_usdc, thresholds)`.
- Build TradePlan via `TradePlanSchema.parse`:
  - `action`: side `no_trade` → `"NO_TRADE"`; else `"LONG"` / `"SHORT"`
  - `side`: aggregation.side if long/short else `"long"` (schema requires it)
  - `entry_price`: aggregation.entry_price; `stop_loss`/`take_profit`: aggregation values; for NO_TRADE: SL = entry*0.99, TP = entry*1.01, `position_size_usdc: 0`, `leverage: 1` (`// reason:` comment explains the encoding)
  - `position_size_contracts` via `computePositionSize(equity, entry, stopLoss, thresholds.risk_per_trade_percent)` (equity from `fetchUserEquity(walletAddress)`, non-fatal → 0)
  - `confidence_score`, `confidence_breakdown`, `thesis`, `reasoning`, `risk_flags`, `graph_patterns_used: []`, `consensus_alignment`, `processingTimeMs`, `iterations`, `timestamp`
- Persistence: after ACCEPT, non-blocking `recordDecision({...} as any).catch(warn)` (mirror DD recordDDReport pattern, agent.ts:228-234).
- Timing tracked per phase (ddMs, planMs, executeMs, aggregateMs, evaluateMs, totalMs).

**Files to create:**

- `lib/agent/planning/agent.ts`
- `__tests__/lib/agent/planning/agent.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/planning/agent.test.ts`
**Dependencies:** T4, T5

- [ ] Step 0: DD auto-call + unknown asset + DD failure paths + equity pre-fetch + tests (mock runDDAgent)
- [ ] Happy path: 3 perspectives agree → ACCEPT → TradePlan with action LONG/SHORT + tests
- [ ] RE-DEPLOY path: 1-2 disagree → second loop → ACCEPT; reDeployCounts cap → forced accept + tests
- [ ] NO_TRADE path: 2+ no_trade → action NO_TRADE + tests
- [ ] FAILED path: all failed → PlanningError + tests
- [ ] Layer 2 gate + TradePlan build (incl. NO_TRADE encoding) + tests

---

### T7 — Pipeline wrapper refactor

**Description:** Thin wrapper, mirrors `lib/agent/due-diligence/pipeline.ts`.

**Acceptance:**

- `runPlanningPipeline(input: { asset: string, userId: string, walletAddress: string, targetProfitPercent?: number })` → `{ report: TradePlan, timing: { totalMs, agentMs } }`
  - `targetProfitPercent` defaults to 100.
  - Calls `runPlanningAgent(...)`; returns `report` (validated `TradePlanSchema.parse`).
  - Errors rethrown as `PlanningError` with message prefix `Planning pipeline failed for <asset>: ...` (keep `PlanningError` class).
- `lib/agent/pipeline.ts` barrel unchanged (already exports `runPlanningPipeline`).

**Files to modify:**

- `lib/agent/planning/pipeline.ts` (full rewrite)
- `__tests__/lib/agent/planning/pipeline.test.ts` (full rewrite — new input shape, mock agent)

**Verification:** `npx vitest run __tests__/lib/agent/planning/pipeline.test.ts` + `npm run typecheck`
**Dependencies:** T6

- [ ] pipeline.ts: thin wrapper + timing + tests
- [ ] typecheck clean (old route.ts consumers still compile against new signature — fix imports in T8)

---

## Phase 4: Cutover (first 2 parallel, then T10)

### T8 — API route + docs

**Description:** New request contract (spec §12) + error contract (§9.6) + circuit breaker integration.

**Acceptance:**

- `POST /api/agent/planning` body: `{ asset: string, userId: string, walletAddress: string, targetProfitPercent?: number }`
  - zod: `asset` non-empty string; `targetProfitPercent` `z.number().positive().max(1000).optional()` (resolved §16.5 — decimal allowed: `100`, `76`, `20.5`; minus, zero, and fraction strings like "1/2" rejected)
  - 400 on missing/invalid fields (`{ error: "asset, userId, and walletAddress required" }` / zod issues)
- Circuit breaker: `isDDPanicked()` or `isLLMPanicked()` → 503 `{ error: "PLANNING_UNAVAILABLE", retryAfterSeconds }`
- Success → 200 `{ report: TradePlan, timing, iterations, status }` (NO_TRADE is a normal 200 with `report.action === "NO_TRADE"`)
- `runPlanningPipeline` throws → 500 with spec §9.6 shapes: `PlanningError` name `PLANNING_FAILED` → `{ error: "PLANNING_FAILED", message, details: { phase: "dd" | "orchestrator" | "execute" | "aggregate" | "evaluate", reports, aggregation, ddReport }, processingTimeMs }`; `CONSENSUS_FAILED` similarly.
- Record `circuitBreaker.recordDDFailure()` when phase "dd" fails, `recordLLMFailure()` on LLM-layer errors (wrap in try/catch).
- `docs/api-documentation.md`: update planning endpoint request/response examples (new body, error shapes).

**Files to modify:**

- `app/api/agent/planning/route.ts`
- `docs/api-documentation.md`
- `__tests__/app/api/agent/planning/route.test.ts` (rewrite)

**Verification:** `npx vitest run __tests__/app/api/agent/planning/`
**Dependencies:** T7

- [ ] route.ts: new body validation + 400 cases + tests
- [ ] route.ts: 503 breaker cases + tests (mock breaker state)
- [ ] route.ts: PLANNING_FAILED / CONSENSUS_FAILED shapes + tests
- [ ] api-documentation.md updated

---

### T9 — Update consumers

**Description:** Dashboard + hooks + execution guard (spec §16.6: breaking change accepted).

**Acceptance:**

- `hooks/use-planning.ts` — request body becomes `{ asset, userId, walletAddress, targetProfitPercent }` (no ddReport); exposes `targetProfitPercent` state (default 100).
- `components/dashboard/plan-section.tsx` — takes `asset` (from DD section's analyzed asset) + target profit input; calls planning on asset; when `plan.action === "NO_TRADE"` show reason and disable approve/execute buttons.
- `lib/agent/execution/pipeline.ts` — guard at top: `if (tradePlan.action === "NO_TRADE") throw new ExecutionError("Cannot execute a NO_TRADE plan")` (defensive; `action` is optional in schema → treat missing as LONG).
- Run full test suite; fix any test referencing old planning input.

**Files to modify:**

- `hooks/use-planning.ts`
- `components/dashboard/plan-section.tsx`
- `lib/agent/execution/pipeline.ts`
- affected tests under `__tests__/`

**Verification:** `npm test`
**Dependencies:** T7

- [ ] use-planning.ts: new body + tests if present
- [ ] plan-section.tsx: asset + target profit + NO_TRADE handling
- [ ] execution guard: NO_TRADE throws + test
- [ ] Full `npm test` green (no regression)

---

### T10 — Cleanup + final verification

**Description:** Delete old linear-pipeline code (spec §15), run full gate.

**Acceptance:**

- Removed from `lib/agent/planning/llm.ts`: `generatePerspective`, `aggregatePerspectives`
- Removed from `lib/agent/planning/prompts.ts`: `PERSPECTIVE_SYSTEM_PROMPTS`, `PERSPECTIVE_USER_PROMPT`, `AGGREGATOR_SYSTEM_PROMPT`, `AGGREGATOR_USER_PROMPT`
- Removed from `lib/agent/planning/types.ts`: `PerspectiveResult`/`PerspectiveResultSchema`, `PlanningPipelineInput`, `AggregatedReasoning` (keep `PerspectiveSchema`, `PlanningAggregationResult`)
- No dead imports: `rg "generatePerspective|aggregatePerspectives|PERSPECTIVE_SYSTEM_PROMPTS|PERSPECTIVE_USER_PROMPT|AGGREGATOR_SYSTEM|AGGREGATOR_USER|PerspectiveResult|PlanningPipelineInput|AggregatedReasoning" lib app components hooks` → zero hits
- `gate.ts` and `risk-engine.ts` KEPT (unchanged)

**Verification:**

- [ ] Dead-code rg sweep clean
- [ ] `npm test` — all tests pass
- [ ] `npm run lint` — zero errors
- [ ] `npm run typecheck` — zero errors
- [ ] `npm run build` — succeeds (smoke)

**Dependencies:** T8, T9

---

## Final Acceptance Gate

- [ ] All 11 tasks completed (T0-T10)
- [ ] Full test suite passes (`npm test`)
- [ ] TypeScript clean (`npm run typecheck`)
- [ ] Lint clean (`npm run lint`)
- [ ] No dead code in `lib/agent/planning/`
- [ ] DD Agent + Execution Agent tests still pass (no regression)
- [ ] POST /api/agent/planning accepts `{ asset, userId, walletAddress, targetProfitPercent }` and auto-runs DD internally
