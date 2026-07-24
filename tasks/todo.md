
# DD Agent Refactor — Task List

**Plan:** `tasks/plan.md`
**Spec:** `docs/refactor/dd-spec.md`

Documentation rule: Every file, function, interface, and inline logic gets JSDoc (`@function`, `@param`, `@returns`, `@description`) or inline `// reason:` comment. Follow existing pattern in `lib/data/hyperliquid.ts`.

TDD rule: Write failing test first (RED) → verify failure → minimal implementation (GREEN) → verify pass → refactor. No production code without a failing test first.

---

## Phase 0: Foundation (Main Agent)

### T0 — Install package + create dirs

**Description:** Install `technicalindicators` npm. Create directory structure for the new tool layer.

**Files to create:**
- `lib/agent/tools/` (dir)
- `lib/agent/tools/technical/` (dir)
- `lib/agent/tools/onchain/` (dir)
- `lib/agent/tools/sentiment/` (dir)
- `lib/agent/tools/fundamental/` (dir)
- `__tests__/lib/agent/tools/` (dir)
- `__tests__/lib/agent/tools/technical/` (dir)
- `__tests__/lib/agent/tools/onchain/` (dir)
- `__tests__/lib/agent/tools/sentiment/` (dir)
- `__tests__/lib/agent/tools/fundamental/` (dir)
- `__tests__/lib/agent/due-diligence/` (dir)

**Verification:** `npm list technicalindicators` shows installed. Directories exist.
**Dependencies:** None

- [ ] `npm install technicalindicators`
- [ ] Create all directories

---

## Phase 1: Types & Schema (2 parallel subagents)

### T1 — Tool types + registry + DDReport extension

**Description:** Create tool interface types (ToolDefinition, ToolResult, ToolRegistry), the registry module, and extend DDReport with new fields.

**Acceptance:**
- `ToolDefinition<TParams>` defined with `name`, `description`, `parameters` (Zod), `execute` → `ToolResult`
- `ToolResult` has `success`, `data?`, `error?`, `metadata.source/latencyMs`
- `ToolRegistry = Record<string, ToolDefinition>`
- `getToolRegistry(factor)` returns subset, `getCrossFactorRegistry()` returns all tools
- DDReport extended: `factorReports`, `overallScore`, `overallConfidence`, `crossValidation`, `risks`, `catalysts`, `summary`, `iterations`, `status`, `processingTimeMs`
- Old fields `aggregated_thesis` and `confidence_score` kept as deprecated aliases
- `FactorReport`, `SignalEntry`, `AgentRunState`, `AgentPlan`, `SubagentPlan`, `ReDeployEntry` types in due-diligence/types.ts

**Files to create:**
- `lib/agent/tools/types.ts`
- `lib/agent/tools/registry.ts`
- `lib/agent/due-diligence/types.ts`
- `__tests__/lib/agent/tools/types.test.ts`
- `__tests__/lib/agent/due-diligence/types.test.ts`

**Files to modify:**
- `lib/agent/types.ts` — EXTEND DDReport, add new interfaces

**Verification:** `npx vitest run __tests__/lib/agent/tools/types.test.ts __tests__/lib/agent/due-diligence/types.test.ts`
**Dependencies:** T0

- [ ] ToolDefinition, ToolResult, ToolRegistry types + tests
- [ ] registry.ts with getToolRegistry + getCrossFactorRegistry + tests
- [ ] DDReport extended with new fields + tests (Zod parse old + new format)
- [ ] due-diligence/types.ts with FactorReport, SignalEntry, AgentRunState, etc. + tests

---

### T2 — DB schema migration

**Description:** Add `dd_reports` collection and `decision_has_factorreport` edge to ArangoDB setup + graph memory.

**Acceptance:**
- `GraphCollectionNames` gains `DD_REPORTS` and `EDGE_HAS_FACTORREPORT`
- `setupArangoGraph()` creates `dd_reports` doc collection + `decision_has_factorreport` edge collection + edge definition
- `recordDDReport(report, userId, walletAddress)` persists to `dd_reports` collection
- DB unavailable → log warning, return empty string (non-fatal)

**Files to create:**
- `__tests__/lib/db/dd-report-persistence.test.ts` — mock arangojs

**Files to modify:**
- `lib/db/arango-types.ts` — add DDReportNode, EDGE_HAS_FACTORREPORT
- `lib/db/setup.ts` — add new collections + edge definitions
- `lib/db/graph-memory.ts` — append recordDDReport()

**Verification:** `npx vitest run __tests__/lib/db/dd-report-persistence.test.ts`
**Dependencies:** T0

- [ ] arango-types.ts: DDReportNode + EDGE_HAS_FACTORREPORT
- [ ] setup.ts: new collections in DOC_COLLECTIONS + EDGE_COLLECTIONS + EDGE_DEFINITIONS
- [ ] graph-memory.ts: recordDDReport() + tests

---

## Phase 2: Tool Implementations (5 parallel subagents)

### T3 — Technical tools: candles + indicators

**Description:** Build candle pre-fetch (3 timeframes) + 13 ToolDefinitions wrapping `technicalindicators` + manual calcs.

**Acceptance:**
- `fetchCandleMap(asset)` → `CandleMap` with `1h` (200), `15m` (200), `1d` (100) candles — uses existing `fetchCandlesByInterval`
- `getTimeframeCandles(timeframe, candleMap)` returns correct array
- All 13 tools registered: `get_rsi`, `get_macd`, `get_ema`, `get_sma`, `get_bb`, `get_atr`, `get_stoch`, `get_obv`, `get_ichimoku`, `get_volume`, `get_support_resistance`, `get_fibonacci`, `get_divergence`
- Each tool: Zod param validation, reads from CandleMap, returns computed values
- `buildTechnicalRegistry(candleMap)` → `ToolRegistry`

**Files to create:**
- `lib/agent/tools/technical/candles.ts`
- `lib/agent/tools/technical/indicators.ts`
- `lib/agent/tools/technical/index.ts`
- `__tests__/lib/agent/tools/technical/candles.test.ts`
- `__tests__/lib/agent/tools/technical/indicators.test.ts`
- `__tests__/lib/agent/tools/technical/index.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/tools/technical/`
**Dependencies:** T1

- [ ] candles.ts: fetchCandleMap + CandleMap type + tests
- [ ] indicators.ts: 13 ToolDefinitions + tests (Zod params, mock candle data, verify indicator output)
- [ ] index.ts: buildTechnicalRegistry + tests

---

### T4 — Onchain tools: HL + DeFiLlama + CG + explorer

**Description:** Wrap existing HL data fetchers + add DeFiLlama, CoinGecko onchain, and simple explorer tracker as ToolDefinitions.

**Acceptance:**
- HL tools: `get_funding_rate`, `get_open_interest`, `get_orderbook_depth`, `get_mark_price`
- DeFiLlama tools: `get_tvl`, `get_protocol_volume`, `get_protocol_fees`
- CG tools: `get_token_supply`, `get_market_cap`, `get_24h_volume`
- Explorer tools: `get_whale_txns` (minValue filter), `get_exchange_flow`
- All tools return `ToolResult` shape, errors → `success: false` + `error` string
- `buildOnchainRegistry()` → `ToolRegistry`

**Files to create:**
- `lib/agent/tools/onchain/hyperliquid.ts`
- `lib/agent/tools/onchain/defillama.ts`
- `lib/agent/tools/onchain/coingecko.ts`
- `lib/agent/tools/onchain/explorer.ts`
- `lib/agent/tools/onchain/index.ts`
- `__tests__/lib/agent/tools/onchain/hyperliquid.test.ts`
- `__tests__/lib/agent/tools/onchain/defillama.test.ts`
- `__tests__/lib/agent/tools/onchain/coingecko.test.ts`
- `__tests__/lib/agent/tools/onchain/explorer.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/tools/onchain/`
**Dependencies:** T1

- [ ] hyperliquid.ts: wrap existing HL calls as tools + tests
- [ ] defillama.ts: DeFiLlama API client + tools + tests
- [ ] coingecko.ts: wrap CG calls as tools + tests
- [ ] explorer.ts: simple whale tracker + tests
- [ ] index.ts: buildOnchainRegistry + tests

---

### T5 — Sentiment tools: cryptocurrency.cv + AltMe

**Description:** Create cryptocurrency.cv API client + wrap AltMe as ToolDefinitions.

**Acceptance:**
- cryptocurrency.cv tools: `get_ai_sentiment`, `get_narratives`, `get_trending_topics`, `get_twitter_sentiment`, `get_ai_research`, `get_news`
- Base URL for cryptocurrency.cv configurable via env var `CRYPTOCURRENCY_CV_BASE_URL`
- AltMe tool: `get_fear_greed` — wraps existing `fetchFearGreedIndex`
- Tools return ToolResult, errors → non-fatal
- `buildSentimentRegistry()` → `ToolRegistry`

**Files to create:**
- `lib/agent/tools/sentiment/cryptocurrencycv.ts`
- `lib/agent/tools/sentiment/altme.ts`
- `lib/agent/tools/sentiment/index.ts`
- `__tests__/lib/agent/tools/sentiment/cryptocurrencycv.test.ts`
- `__tests__/lib/agent/tools/sentiment/altme.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/tools/sentiment/`
**Dependencies:** T1

- [ ] cryptocurrencycv.ts: 6 tools + HTTP client + tests
- [ ] altme.ts: wrap fetchFearGreedIndex as tool + tests
- [ ] index.ts: buildSentimentRegistry + tests

---

### T6 — Fundamental tools: CG metadata + PublicDrop

**Description:** Wrap existing CoinGecko metadata + PublicDrop fetchers as ToolDefinitions.

**Acceptance:**
- CG metadata tools: `get_coin_metadata`, `get_tokenomics` (supply + unlock), `get_ath`, `get_developer_activity` (GitHub stats)
- PublicDrop tools: `get_unlock_events`, `get_inflation_data`
- Tools return ToolResult, errors → non-fatal
- `buildFundamentalRegistry()` → `ToolRegistry`

**Files to create:**
- `lib/agent/tools/fundamental/coingecko-metadata.ts`
- `lib/agent/tools/fundamental/publicdrop.ts`
- `lib/agent/tools/fundamental/index.ts`
- `__tests__/lib/agent/tools/fundamental/coingecko-metadata.test.ts`
- `__tests__/lib/agent/tools/fundamental/publicdrop.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/tools/fundamental/`
**Dependencies:** T1

- [ ] coingecko-metadata.ts: wrap as tools + tests
- [ ] publicdrop.ts: wrap as tools + tests
- [ ] index.ts: buildFundamentalRegistry + tests

---

### T7 — Cross-factor registry + Binance fallback

**Description:** Update main registry to include cross-factor access for Main Agent. Refactor Binance fallback as tools.

**Acceptance:**
- `getCrossFactorRegistry()` returns ALL tools (technical + onchain + sentiment + fundamental)
- Binance tools: `get_binance_funding`, `get_binance_oi`, `get_binance_volume`
- Main Agent can access any tool for cross-verification between factors

**Files to create:**
- `__tests__/lib/agent/tools/registry-cross.test.ts`

**Files to modify:**
- `lib/agent/tools/registry.ts` — add `getCrossFactorRegistry()`
- `lib/data/onchain/binance.ts` — add tool wrappers (keep existing functions, add new exports)

**Verification:** `npx vitest run __tests__/lib/agent/tools/registry-cross.test.ts`
**Dependencies:** T1, T3, T4, T5, T6

- [ ] getCrossFactorRegistry tests: contains all factor registries
- [ ] Binance tool wrappers: wrap fetchBinanceOnchain as tools + tests

---

## Phase 3: SubAgent ReAct (2 sequential subagents)

### T8 — SubAgent generic ReAct loop + evaluation

**Description:** Build the generic ReAct loop that each factor subagent uses. + structured evaluation logic.

**Acceptance:**
- `runSubagent({factor, tools, instruction, asset, maxLoops?, timeoutMs?})` → `FactorReport`
- Internal: THINK (LLM decides tool_call or return) → ACT (tool.execute) → OBSERVE (record result) → REFLECT (loop or return)
- Max 3 loops — if LLM still wants more at loop 3, force return with partial data
- 60s timeout per subagent — force stop, return partial FactorReport
- Tool failure → record in `FactorReport.errors[]`, continue with other tools
- `evaluateResults(factorReports, aggregated)` → `{decision, lowConfidenceFactors}`
- Decision matrix:
  - >=3 factors confidence >= 60, no contradictions → ACCEPT
  - 1-2 factors < 60 → RE-DEPLOY
  - >=3 factors fail → PARTIAL
  - Contradictions found → RE-DEPLOY cross-verify

**Files to create:**
- `lib/agent/due-diligence/subagent.ts`
- `lib/agent/due-diligence/evaluate.ts`
- `__tests__/lib/agent/due-diligence/subagent.test.ts`
- `__tests__/lib/agent/due-diligence/evaluate.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/due-diligence/subagent.test.ts __tests__/lib/agent/due-diligence/evaluate.test.ts`
**Dependencies:** T1 (types), T3-T7 (tools)

- [ ] runSubagent: THINK→ACT loop with ≤3 iterations + tests
- [ ] runSubagent: tool failure → error metadata, continue + tests
- [ ] runSubagent: timeout → partial FactorReport + tests
- [ ] evaluateResults: all decision matrix branches + tests

---

### T9 — LLM prompts for ReAct + integration

**Description:** Refactor LLM module for subagent THINK step + main agent PLAN/AGGREGATE/EVALUATE prompts.

**Acceptance:**
- `think()` — LLM call for subagent THINK step, returns parsed SubAgentThought (action: "tool_call" or "return")
- `plan()` — LLM call for initial plan: subagent list + instructions
- `rePlan()` — LLM call for re-deploy plan: targeted instructions for low-confidence factors
- `aggregate()` — LLM call merging FactorReports → thesis + cross-validation
- ReAct system prompts include tool descriptions (format per spec §7.2) for each factor
- Aggregation prompt includes cross-validation + risk/catalyst instructions
- Main agent thinking mode: `deepseek-v4-pro`, subagent non-thinking: `deepseek-v4-flash`
- SubAgentThoughtSchema validates LLM output (discriminated union: tool_call | return)

**Files to modify:**
- `lib/agent/due-diligence/llm.ts` — add think(), plan(), rePlan(), aggregate()
- `lib/agent/due-diligence/prompts.ts` — add ReAct prompts for all 4 factors + aggregation + evaluation
- `lib/agent/due-diligence/__tests__/` — integration tests with mock LLM

**Verification:** `npx vitest run __tests__/lib/agent/due-diligence/llm-rethought.test.ts`
**Dependencies:** T8

- [ ] think() with SubAgentThoughtSchema + tests
- [ ] plan() + rePlan() + tests
- [ ] aggregate() + tests
- [ ] ReAct prompts with formatted tool descriptions + tests
- [ ] Aggregation + evaluation prompts + tests

---

## Phase 4: Main Agent (2 sequential subagents)

### T10 — Main Agent Plan-Execute-Reflect

**Description:** Build DDAgentMain that coordinates the full swarm: plans, deploys subagents in parallel, aggregates, evaluates, re-deploys if needed.

**Acceptance:**
- `runDDAgent({asset, category, maxLoops?})` → `DDReport`
- Loop (max 5):
  1. PLAN: LLM generates subagent list + instructions
  2. EXECUTE: `Promise.all(runSubagent())` for all active factors
  3. AGGREGATE: LLM merge + `computeDeterministicScore()`
  4. EVALUATE: structured check from evaluate.ts
  5. RE-DEPLOY or ACCEPT/PARTIAL/FAILED
- `computeDeterministicScore()` — weighted composite from FactorReport scores
- `buildFinalReport()` — merges FactorReports + LLM aggregation + deterministic scoring
- Happy path: all 4 factors OK → complete with overallScore, overallConfidence
- Re-deploy: low confidence → second loop with targeted instruction → ACCEPT
- All fail: status = "failed"
- Processing time tracked across all loops

**Files to create:**
- `lib/agent/due-diligence/agent.ts`
- `__tests__/lib/agent/due-diligence/agent.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/due-diligence/agent.test.ts`
**Dependencies:** T8, T9

- [ ] runDDAgent happy path + tests
- [ ] runDDAgent re-deploy path + tests
- [ ] runDDAgent partial + failed paths + tests
- [ ] computeDeterministicScore + buildFinalReport + tests

---

### T11 — Pipeline wrapper refactor

**Description:** Refactor `runDDPipeline()` into a thin wrapper calling `runDDAgent()`. Maintain interface compatibility.

**Acceptance:**
- `runDDPipeline(input)` calls `runDDAgent()` internally instead of current linear flow
- Output includes new DDReport fields (factorReports, overallScore, etc.)
- `DDPipelineOutput.timing` updated to track agent phases (planMs, executeMs, aggregateMs vs old fetchMs/llmMs)
- Old data-fetch logic removed from pipeline (now handled by subagent tools)

**Files to modify:**
- `lib/agent/due-diligence/pipeline.ts` — complete refactor
- `lib/agent/pipeline.ts` — barrel export (verify it still exports runDDPipeline)

**Files to create:**
- `__tests__/lib/agent/due-diligence/pipeline.test.ts`

**Verification:** `npx vitest run __tests__/lib/agent/due-diligence/pipeline.test.ts`
**Dependencies:** T10

- [ ] pipeline.ts: thin wrapper calling runDDAgent + tests
- [ ] Timing: planMs/executeMs/aggregateMs tracked + tests

---

## Phase 5: Cutover (3 tasks, last 2 parallel)

### T12 — Update API route

**Description:** Update `/api/agent/dd` route to accept new input format and return new DDReport.

**Acceptance:**
- POST with `{asset, userId}` returns 200 with new DDReport
- POST without required fields returns 400
- Error cases: LLM failure → 500, asset not found → 400

**Files to modify:**
- `app/api/agent/dd/route.ts`

**Files to create:**
- `__tests__/app/api/agent/dd/route.test.ts` — mock pipeline

**Verification:** `npx vitest run __tests__/app/api/agent/dd/`
**Dependencies:** T11

- [ ] route.ts: updated to call new pipeline + tests
- [ ] Error handling: 400 for missing fields, 500 for pipeline failure + tests

---

### T13 — Update consumers

**Description:** Update all DDReport consumers to use new field names.

**Acceptance:**
- Planning pipeline reads `summary` (was `aggregated_thesis`), `overallConfidence` (was `confidence_score`)
- Dashboard DD section reads `summary` + `overallConfidence` from new DDReport
- Trade pipeline DDReport reads updated if any
- Old field names removed (only forward-compat as deprecated aliases in types)
- All consumer tests still pass

**Files to modify:**
- `lib/agent/planning/pipeline.ts` — update field references
- `lib/agent/execution/pipeline.ts` — update if reads DDReport fields
- `lib/agent/trade/*.ts` — update if reads DDReport fields
- `components/dashboard/dd-section.tsx` — update `aggregated_thesis` → `summary`, `confidence_score` → `overallConfidence`
- `hooks/use-dd.ts` (if exists) — update types

**Verification:** `npm test` (full suite)
**Dependencies:** T11

- [ ] planning pipeline: updated field names + tests
- [ ] dashboard: dd-section reads new fields
- [ ] All other consumers updated

---

### T14 — Cleanup + final verification

**Description:** Remove old linear pipeline code, run full test suite + lint + typecheck.

**Acceptance:**
- Old `fetchAllRawData()` removed from providers.ts if no other consumers
- Old `analyzeSection()`, `synthesizeSections()`, old prompts removed from due-diligence/llm.ts, prompts.ts
- `npm test` passes (all tests)
- `npm run lint` passes
- `npm run typecheck` passes (zero TS errors)
- No dead code left

**Verification:**
- [ ] `npm test` — all tests pass
- [ ] `npm run lint` — zero errors
- [ ] `npm run typecheck` — zero errors
- [ ] Verify no dead old functions remain

**Dependencies:** T12, T13

---

## Final Acceptance Gate

- [ ] All 14 tasks completed
- [ ] Full test suite passes (`npm test`)
- [ ] TypeScript clean (`npm run typecheck`)
- [ ] Lint clean (`npm run lint`)
- [ ] No dead code in due-diligence/ directory
- [ ] Planning Agent + Execution Agent tests still pass (no regression)
