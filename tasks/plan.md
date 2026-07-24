
# Implementation Plan: DD Agent Refactor — Multi-Agent Swarm

**Spec:** `docs/refactor/dd-spec.md` (Draft)
**Ref:** `docs/odin-spec.md` §4.1
**Previous pattern:** `tasks/plan.md` (Execution Agent plan)

---

## Overview

Refactor linear `runDDPipeline()` into a multi-agent swarm with ReAct loops. Each factor (technical, onchain, sentiment, fundamental) gets its own SubAgent with a ReAct loop (max 3 iterations) that picks tools at runtime. A Main Agent (DDAgentMain) coordinates via Plan-Execute-Reflect: plans subagent deployment, parallel-executes, aggregates results, evaluates quality, and re-deploys if confidence low.

Architecture: `Tool-Swarm Pattern` — Tool layer → SubAgent ReAct → Main Agent Plan-Execute-Reflect → Cutover.

## Architecture Decisions

1. **Technical indicators**: `technicalindicators` npm (pure JS, zero infra) + 3-timeframe pre-fetch from existing HL `fetchCandles()`. No Python, no Docker, no Tickscope.
2. **Tool discovery**: Self-correct via ReAct loop only — no pre-check layer. LLM picks tools, observes errors, retries within 3-loop ceiling.
3. **SubAgent parallelization**: `Promise.all` over 4 subagents — DeepSeek holds requests open rather than 429.
4. **LLM config**: SubAgent = `deepseek-v4-flash` non-thinking (temp 0.3). Main Agent = `deepseek-v4-pro` thinking (temp ignored). JSON mode for both.
5. **DB migration**: Add `dd_reports` collection + `decision_has_factorreport` edge. Update `setupArangoGraph()` atomically.
6. **DDReport breaking change**: Rename `aggregated_thesis` → `summary`, `confidence_score` → `overallConfidence`. Add `factorReports`, `crossValidation`, `risks`, `catalysts`, `status`, `iterations`, `processingTimeMs`. All consumers updated in phase 4.
7. **Meme category**: LLM-driven skip (no hardcoded filter) — PLAN prompt tells LLM to skip FundamentalSubAgent for meme coins.
8. **CoinGecko rate limit**: Not handled in code for MVP. ReAct natural ceiling (max 3 calls per subagent) is sufficient.
9. **No budget cap**: Each DD run ≈ max 17 LLM calls, < $0.05.
10. **TDD per file**: Every task writes failing test → minimal implementation → verify. No production code without a failing test first.
11. **Documentation comments**: Every file, function, interface, and inline logic block must have JSDoc or inline comments following existing pattern (`@function`, `@param`, `@returns`, `@description`)

## Task List

### Phase 0: Foundation (1 task)

- [ ] **T0:** Install `technicalindicators` npm. Create directory structure: `lib/agent/tools/types.ts`, `lib/agent/tools/technical/`, `lib/agent/tools/onchain/`, `lib/agent/tools/sentiment/`, `lib/agent/tools/fundamental/`. Create test directories.

### Checkpoint: Foundation
- [ ] `npm install technicalindicators` succeeds
- [ ] Directory structure matches spec

---

### Phase 1: Types & Schema — 2 tasks, parallel

- [ ] **T1:** Tool interface types + registry + DDReport extension
  - `lib/agent/tools/types.ts` — `ToolDefinition<TParams>`, `ToolResult`, `ToolRegistry`
  - `lib/agent/tools/registry.ts` — `buildToolRegistry()`, `getToolRegistry(factor)`
  - `lib/agent/types.ts` — EXTEND DDReport: add `factorReports`, `overallScore`, `overallConfidence`, `crossValidation`, `risks`, `catalysts`, `summary`, `iterations`, `status`, `processingTimeMs`. Rename `aggregated_thesis` → `summary`, `confidence_score` → `overallConfidence` (add new fields, keep old as deprecated aliases for migration).
  - `lib/agent/due-diligence/types.ts` — `FactorReport`, `SignalEntry`, `AgentRunState`, `AgentPlan`, `SubagentPlan`, `ReDeployEntry`, `CrossValidation`, `ValidationPair`, `RiskEntry`, `CatalystEntry`
  - Tests for all schemas + type instantiations

- [ ] **T2:** DB schema migration
  - `lib/db/arango-types.ts` — add `DDReportNode` interface, add `EDGE_HAS_FACTORREPORT` to `GraphCollectionNames`
  - `lib/db/setup.ts` — update `setupArangoGraph()`: add `dd_reports` document collection, add `decision_has_factorreport` edge collection, add edge definition to graph
  - `lib/db/graph-memory.ts` — append `recordDDReport(report: DDReport, userId, walletAddress)` for persistence
  - Tests for migration + persistence functions

### Checkpoint: Types & Schema
- [ ] T1 + T2 tests pass (parallel)
- [ ] TypeScript compiles clean (`npx tsc --noEmit`)

---

### Phase 2: Tool Implementations — 5 tasks, parallel (all depend on T1 types)

- [ ] **T3:** Technical tools — candle pre-fetch + indicators
  - `lib/agent/tools/technical/candles.ts` — `CandleMap`, `fetchCandleMap(asset)`, `getTimeframeCandles(timeframe)` — pre-fetch 3 timeframes at subagent start
  - `lib/agent/tools/technical/indicators.ts` — ~12 ToolDefinitions: `get_rsi`, `get_macd`, `get_ema`, `get_sma`, `get_bb`, `get_atr`, `get_stoch`, `get_obv`, `get_ichimoku`, `get_volume`, `get_support_resistance`, `get_fibonacci`, `get_divergence`
  - `lib/agent/tools/technical/index.ts` — `buildTechnicalRegistry(candleMap)` → `ToolRegistry`
  - Tests: each tool validates Zod params, reads from mock candle map, returns correct indicator values

- [ ] **T4:** Onchain tools — Hyperliquid + DeFiLlama + CoinGecko + explorer
  - `lib/agent/tools/onchain/hyperliquid.ts` — wrap existing HL calls as tools: `get_funding_rate`, `get_open_interest`, `get_orderbook_depth`, `get_mark_price`
  - `lib/agent/tools/onchain/defillama.ts` — NEW: DeFiLlama API client: `get_tvl`, `get_protocol_volume`, `get_protocol_fees`
  - `lib/agent/tools/onchain/coingecko.ts` — wrap existing CG calls as tools: `get_token_supply`, `get_market_cap`, `get_24h_volume`
  - `lib/agent/tools/onchain/explorer.ts` — NEW: simple whale tx tracker via public explorer endpoints: `get_whale_txns`, `get_exchange_flow`
  - `lib/agent/tools/onchain/index.ts` — `buildOnchainRegistry()` → `ToolRegistry`
  - Tests: mock HTTP responses, validate Zod schemas, test error handling

- [ ] **T5:** Sentiment tools — cryptocurrency.cv + AltMe
  - `lib/agent/tools/sentiment/cryptocurrencycv.ts` — NEW: cryptocurrency.cv API client: `get_ai_sentiment`, `get_narratives`, `get_trending_topics`, `get_twitter_sentiment`, `get_ai_research`, `get_news`
  - `lib/agent/tools/sentiment/altme.ts` — wrap existing AltMe as tool: `get_fear_greed`
  - `lib/agent/tools/sentiment/index.ts` — `buildSentimentRegistry()` → `ToolRegistry`
  - Tests: mock HTTP, validate tool routing, error on API failure

- [ ] **T6:** Fundamental tools — CoinGecko metadata + PublicDrop
  - `lib/agent/tools/fundamental/coingecko-metadata.ts` — wrap existing CG calls: `get_coin_metadata`, `get_tokenomics`, `get_ath`, `get_developer_activity`
  - `lib/agent/tools/fundamental/publicdrop.ts` — wrap existing PublicDrop: `get_unlock_events`, `get_inflation_data`
  - `lib/agent/tools/fundamental/index.ts` — `buildFundamentalRegistry()` → `ToolRegistry`
  - Tests: mock HTTP, validate each tool's response shape

- [ ] **T7:** Cross-factor tools + Binance fallback
  - `lib/agent/tools/registry.ts` — UPDATE: `getCrossFactorRegistry()` — registry with ALL tools for Main Agent
  - `lib/data/onchain/binance.ts` — REFACTOR as fallback tool: `get_binance_funding`, `get_binance_oi`, `get_binance_volume`
  - Ensure Main Agent can access any tool for cross-verification
  - Tests: verify cross-factor registry contains all tools, binance fallback tools

### Checkpoint: Tool Layer
- [ ] T3-T7 all tests pass
- [ ] TypeScript compiles clean
- [ ] All tool registries build and export correctly

---

### Phase 3: SubAgent ReAct — 2 tasks, sequential

- [ ] **T8:** SubAgent generic ReAct loop + evaluation
  - `lib/agent/due-diligence/subagent.ts` — `runSubagent({factor, tools, instruction, asset, maxLoops?, timeoutMs?})` → `FactorReport`
  - Internal: THINK (LLM) → ACT (tool.execute) → OBSERVE → REFLECT (loop or return)
  - Max 3 loops, 60s timeout, tool failure → error in `FactorReport.errors[]`
  - `lib/agent/due-diligence/evaluate.ts` — `evaluateResults(factorReports, aggregated)` → `{decision: "ACCEPT"|"RE-DEPLOY"|"PARTIAL"|"FAILED", lowConfidenceFactors: []}`
  - Tests: assert ≤3 loops, tool failure handling, timeout → partial, eval decision matrix

- [ ] **T9:** LLM prompts for ReAct + integration tests
  - `lib/agent/due-diligence/llm.ts` — REFACTOR: add `think()` for subagent THINK step, `plan()` for initial plan, `rePlan()` for re-deploy, `aggregate()` for merging FactorReports, `evaluate()` for structured evaluation
  - `lib/agent/due-diligence/prompts.ts` — REFACTOR: add ReAct system prompts (tool description format per §7.2), aggregation prompt, evaluation prompt, re-deploy prompt, plan prompt
  - Integration tests: mock LLM responses, test each THINK path (tool_call vs return), test plan/aggregate/evaluate decision paths

### Checkpoint: SubAgent
- [ ] T8 + T9 tests pass
- [ ] ReAct loop works with mock tools (≤3 calls, returns FactorReport)
- [ ] Evaluation covers all ACCEPT/RE-DEPLOY/PARTIAL/FAILED scenarios

---

### Phase 4: Main Agent — 2 tasks, sequential (depend on T8-T9)

- [ ] **T10:** Main Agent — Plan-Execute-Reflect
  - `lib/agent/due-diligence/agent.ts` — `runDDAgent({asset, category, maxLoops?})` → `DDReport`
  - Internal loop (max 5): PLAN → EXECUTE (Promise.all 4 subagents) → AGGREGATE (LLM) → EVALUATE → RE-DEPLOY or ACCEPT/PARTIAL/FAILED
  - Deterministic: `computeDeterministicScore()` — weighted composite from FactorReport scores
  - `buildFinalReport()` — merges FactorReports + LLM aggregation + deterministic scoring
  - Tests: happy path (all factors OK → ACCEPT), partial (1-2 fail → PARTIAL), all fail → FAILED, re-deploy → confidence increases → ACCEPT

- [ ] **T11:** Pipeline wrapper refactor
  - `lib/agent/due-diligence/pipeline.ts` — REFACTOR: thin wrapper calling `runDDAgent()` instead of current linear flow
  - Maintain same `DDPipelineInput` / `DDPipelineOutput` interface (update to new DDReport)
  - `lib/agent/pipeline.ts` — update barrel export (already exports `runDDPipeline`)
  - Tests: pipeline integration with mocked agent, verify output shape matches new DDReport

### Checkpoint: Main Agent
- [ ] T10 + T11 tests pass
- [ ] Full pipeline runs with mocked subagents
- [ ] DDReport shape matches extended schema

---

### Phase 5: Cutover — 3 tasks, parallel where possible

- [ ] **T12:** Update API route
  - `app/api/agent/dd/route.ts` — update to call new pipeline, return new DDReport shape
  - Tests: POST /api/agent/dd with valid body returns 200 + new DDReport format, error cases

- [ ] **T13:** Update consumers
  - `lib/agent/planning/pipeline.ts` — update to read new DDReport fields (`summary` instead of `aggregated_thesis`, `overallConfidence` instead of `confidence_score`)
  - `lib/agent/execution/pipeline.ts` — update DDReport reads if any
  - `lib/agent/trade/` — update DDReport reads if any
  - `components/dashboard/dd-section.tsx` — update field references
  - Tests: verify consumer tests still pass

- [ ] **T14:** Cleanup + E2E verification
  - Remove old functions from `lib/agent/due-diligence/llm.ts` and `prompts.ts` that are replaced
  - Remove old `lib/data/providers.ts` `fetchAllRawData()` if no longer used (check consumers first)
  - Full suite: `npm test`, `npm run lint`, `npm run typecheck`
  - E2E: single BTC analysis via dashboard → verify DDReport in ArangoDB

### Checkpoint: Complete
- [ ] All 14 task tests pass
- [ ] Zero TypeScript errors
- [ ] Zero lint errors
- [ ] All existing agent tests still pass (no regression)
- [ ] E2E: BTC analysis runs end-to-end

## Parallel Execution Strategy

```
Phase 0: T0 ────┐
                 │
Phase 1:   T1 ──┤─── (parallel) ──── T2
                 │
Phase 2:   T3  T4  T5  T6  T7 (5 parallel, after T1)
                 │
Phase 3:   T8 ──→─── T9 (sequential)
                 │
Phase 4:   T10 ─→─── T11 (sequential)
                 │
Phase 5:   T12 ─── T13 (parallel) ─── T14 (after both)
```

Max parallel agents: **5** (Phase 2 tool implementations).

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `technicalindicators` API mismatch | Indicator tools return wrong values | Write tests per tool with known inputs/outputs; verify with sample data |
| cryptocurrency.cv rate limit | Sentiment tools fail in CI | Mock all HTTP in unit tests. Document 100 req/15min limit. |
| DeepSeek V4 thinking mode temp ignored | Main agent reasoning not controllable | Document that temp is ignored in thinking mode; rely on `reasoning_effort` |
| DDReport rename breaks consumers | Pipeline tests fail | Add backward-compat getters in T1, remove in T14 |
| ArangoDB not in CI | DB tests fail | Mock arangojs in all DB tests |
| ReAct LLM always returns on loop 1 | Never uses tools, defeating purpose | Add prompt engineering: "Use at least 2 tools before returning". Test with `≤3` assertion. |

## Open Questions

None — all resolved in spec §14 (Decision Log).

## Documentation Standards

Every file must have:
- File-level JSDoc (`@file`, `@description`)
- Every exported function: `@function`, `@description`, `@param`, `@returns`
- Every interface/type: `@interface`, `@description`
- Every non-trivial inline logic block: inline `// reason:` comment
- Zod schemas: `@constant`, `@description` JSDoc above schema
- Follow existing pattern in `lib/data/hyperliquid.ts` and `lib/agent/types.ts`
