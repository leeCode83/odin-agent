# Implementation Plan: Planning Agent Refactor — Multi-Perspective Swarm

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the linear planning pipeline into a multi-perspective swarm agent with ReAct subagents, 2-layer consensus evaluation, and NO_TRADE detection.

**Architecture:** Orchestrator (Plan-Execute-Reflect, deepseek-v4-pro thinking) deploys 3 perspective subagents (conservative/balance/aggressive, deepseek-v4-flash ReAct, max 5 loops) with planning tools (risk engine, market data, web search, funding/liquidation vibes). Aggregator merges reports; deterministic Layer 1 consensus evaluation decides ACCEPT / RE-DEPLOY / NO_TRADE / FAILED; Layer 2 reuses `autonomyGate()`. API route auto-calls DD agent internally (step 0), no longer receives `ddReport`.

**Tech Stack:** Next.js 16, DeepSeek (openai SDK), @nktkas/hyperliquid, ArangoDB (arangojs), zod, technicalindicators, vitest. No new npm dependencies.

**Spec:** `docs/refactor/planning-spec.md`
**Ref:** `docs/odin-spec.md` §4.2
**Previous pattern:** `tasks/plan.md` + `tasks/todo.md` (DD Agent Refactor, complete)

## Global Constraints

- **Doc comments:** every file, function, interface, and non-trivial inline block gets JSDoc (`@file`, `@function`, `@description`, `@param`, `@returns`, `@interface`, `@constant`) or inline `// reason:` comment. Follow existing examples: `lib/data/hyperliquid.ts`, `lib/agent/due-diligence/agent.ts`, `lib/agent/due-diligence/subagent.ts`, `lib/agent/tools/types.ts`.
- **TDD:** failing test first (RED) → verify failure → minimal implementation (GREEN) → verify pass. No production code without a failing test first.
- **No new dependencies:** Exa web search via plain `fetch`; all other data from existing `lib/data/` + `lib/db/` + existing tool layer.
- **Verification commands:** `npx vitest run <test-path>` per task; full gate = `npm test`, `npm run lint`, `npm run typecheck`.
- **Reuse:** no new subagent loop implementation — reuse DD `runSubagent()`. No new tool interface — reuse `ToolDefinition`/`ToolResult`/`ToolRegistry` from `lib/agent/tools/types.ts`.
- **Keep working code green:** old pipeline/llm/prompts stay until T10 removes them. Every task must leave `npm run typecheck` passing.

---

## Overview

Refactor linear `runPlanningPipeline()` into a multi-perspective swarm. Each perspective (conservative, balance, aggressive) becomes a ReAct subagent (max 5 loops, 60s timeout) that calls planning tools iteratively. Orchestrator `runPlanningAgent()` mirrors the DD Main Agent: PLAN → EXECUTE (Promise.all) → AGGREGATE → EVALUATE (Layer 1 consensus) → RE-DEPLOY (max 2x per perspective). Layer 2 = existing `autonomyGate()`. Agent can conclude NO_TRADE. API route body changes to `{ asset, userId, walletAddress, targetProfitPercent }` and auto-calls `runDDAgent()` internally.

## Architecture Decisions

1. **Subagent reuse:** Planning perspective subagents call the existing DD `runSubagent()` (`lib/agent/due-diligence/subagent.ts`) with `factor` = perspective name, `maxLoops = 5`, `timeoutMs = 60000`, planning-specific `getSystemPrompt`. No loop rewrite.
2. **Rich return via schema extension:** `SubAgentThoughtSchema` "return" variant gains OPTIONAL fields (`side`, `entry_price`, `suggested_stop_loss`, `suggested_take_profit`, `suggested_leverage`, `suggested_position_size_usdc`, `risk_flags`). Zod strips unknown keys, so capture is only possible with the extension. DD behavior unchanged (extras ignored). Planning wrapper's `llmThink` stashes the last parsed return thought and merges extras into `PerspectiveReport` after `runSubagent()` resolves — zero DD core edits.
3. **LLM config:** Perspective subagents reuse DD `think()` (deepseek-v4-flash, temp 0.3, json_object). Orchestrator `plan()`/`aggregate()`/`rePlan()` use new `DEEPSEEK_THINK_MODEL` env (default `deepseek-v4-pro`), thinking mode (no temperature, `reasoning_effort` from `DEEPSEEK_REASONING_EFFORT`), json_object, max_tokens 8192.
4. **Risk engine:** keep deterministic; existing functions become tool `execute()` bodies (no logic change). Tools let the LLM do what-if analysis.
5. **Vibe tools honest approximation:** Hyperliquid public API has NO liquidation data (verified against HL docs, spec §16.2). `check_liquidation_zones`/`assess_cascade_risk` use orderbook + funding + OI proxies and label themselves "approximation" in descriptions + results. `analyze_funding_regime` uses HL assetCtx current funding/OI/mark + predicted funding (`predictedFundings` endpoint, `HlPerp` venue) when available (spec §16.3).
6. **Web search graceful failure:** no `EXA_API_KEY` configured in repo (spec §16.1). Tool built against `https://api.exa.ai/search` (POST, Bearer), returns `success: false` with clear message when key missing — subagent continues with other tools. Add `EXA_API_KEY` (optional) to `.env.example`.
7. **Equity pre-fetch:** no `get_equity` tool (spec §16.4). Orchestrator pre-fetches equity once via public `fetchUserEquity(walletAddress)` (no auth needed) and passes it through registry context `{ walletAddress, userId, asset, equity }`.
8. **targetProfitPercent:** decimal percent (100 = 100%, 20.5 = 20.5%). Route zod-validates `z.number().positive().max(1000)` (spec §16.5 resolved) — no minus, no zero, no fraction strings ("1/2", "75%" → 400). Default 100.
9. **Breaking API change:** planning route drops `ddReport` from body (spec §16.6 resolved). Consumers updated in T9. Dashboard keeps DD + planning as separate calls (spec §16.7 resolved: latency 90-120s accepted, loading states exist).
10. **Re-deploy replaces report:** per-perspective map dedupe (mirror DD agent.ts line 193-196 pattern) — latest report per perspective wins (spec §16.8 resolved).
11. **NO_TRADE TradePlan encoding:** `TradePlanSchema.action` gains `LONG | SHORT | NO_TRADE` with `.default("LONG")` (non-breaking for old constructors). NO_TRADE plans use `side` fallback, `position_size_usdc = 0`, `leverage = 1`, SL/TP = ±1% dummy around entry (schema requires positive numbers). Execution pipeline guards against NO_TRADE.
12. **Circuit breaker:** in-memory per-process (spec §9.7), new `circuit-breaker.ts`. No persistence.
13. **Logging:** new `log.ts` helper (spec §9.8 levels/events), DEBUG gated behind `NODE_ENV === "development"`.
14. **Persistence:** best-effort non-blocking `recordDecision()` call after ACCEPT (spec §10.2), wrapped in try/catch — DB down never fails the request.
15. **TDD per task:** same as DD refactor. Tests mock all HTTP, LLM, and arangojs.
16. **Docs:** every file, function, interface, and inline logic block must have JSDoc or inline comments following existing pattern (`@function`, `@param`, `@returns`, `@description`).

## Task List

### Phase 0: Foundation (1 task)

- [ ] **T0:** Create `lib/agent/planning/tools/` + `__tests__/lib/agent/planning/tools/` dirs. Add `DEEPSEEK_THINK_MODEL` + `EXA_API_KEY` (optional) to `.env.example`. No npm install needed (technicalindicators already present).

### Checkpoint: Foundation

- [ ] Directories exist; `.env.example` updated; typecheck clean

---

### Phase 1: Types & Tools — 3 tasks, parallel

- [ ] **T1:** Types + schema extensions
  - `lib/agent/planning/types.ts` — ADD `PerspectiveReportSchema`/`PerspectiveReport`, `PlanningSubagentPlan`, `PlanningAgentPlan`, `ReDeployEntry`, `ConsensusResult`, `PlanningAgentInput`, `PlanningAgentOutput`, `PlanningAggregationResult`. KEEP `PerspectiveSchema`; mark `PerspectiveResult`/`PlanningPipelineInput`/`AggregatedReasoning` deprecated (removed T10).
  - `lib/agent/types.ts` — TradePlanSchema: add `action: z.enum(["LONG","SHORT","NO_TRADE"]).default("LONG")` + optional `consensus_alignment`, `processingTimeMs`, `iterations`.
  - `lib/agent/due-diligence/subagent.ts` — extend `SubAgentThoughtSchema` return variant with optional `side`, `entry_price`, `suggested_stop_loss`, `suggested_take_profit`, `suggested_leverage`, `suggested_position_size_usdc`, `risk_flags`. NO other change.
  - Tests: zod parses old + new TradePlan, thought schema with/without extras, DD tests still pass.

- [ ] **T2:** Risk engine + market data tools
  - `lib/agent/planning/tools/risk-engine.ts` — `compute_atr`, `compute_sltp`, `compute_position_size`, `cap_leverage` wrapping `lib/agent/planning/risk-engine.ts` (no logic change).
  - `lib/agent/planning/tools/market-data.ts` — `get_mark_price`, `get_candles`, `get_risk_thresholds`, `get_graph_patterns`; `get_orderbook_depth` re-exported from existing `lib/agent/tools/onchain/hyperliquid.ts`. NO `get_equity` tool (equity pre-fetched by orchestrator, flows via ctx).
  - `lib/agent/planning/tools/index.ts` — `buildPlanningToolRegistry(ctx)` → `ToolRegistry`.
  - Tests: each tool Zod validation, mock data, error → `success: false`.

- [ ] **T3:** Vibe + web tools
  - `lib/agent/planning/tools/funding.ts` — `analyze_funding_regime`, `detect_oi_funding_divergence` (HL assetCtx current funding/OI/mark via existing data layer; deterministic thresholds: |funding| > 0.05% → overheated; include predicted funding `HlPerp` when available).
  - `lib/agent/planning/tools/liquidation.ts` — `check_liquidation_zones`, `assess_cascade_risk` (orderbook/OI approximation, honest labeling).
  - `lib/agent/planning/tools/web-search.ts` — `web_search` via Exa API (fetch; missing key → graceful `success: false`).
  - Tests: mock fetch, funding thresholds, missing-key path.

### Checkpoint: Types & Tools

- [ ] T1-T3 tests pass (parallel); typecheck clean; all registries build

---

### Phase 2: Subagent + Evaluation — 2 tasks, parallel

- [ ] **T4:** Perspective subagent wrapper + LLM + prompts
  - `lib/agent/planning/subagent.ts` — `runPerspectiveSubagent({ perspective, instruction, asset, ddReport, targetProfitPercent, toolRegistry })` → `PerspectiveReport`. Calls DD `runSubagent()`; `llmThink` = planning wrapper stashing return thought; `getSystemPrompt` = planning ReAct factory.
  - `lib/agent/planning/llm.ts` — ADD `plan()`, `rePlan()`, `aggregate()` (deepseek-v4-pro thinking). Old `generatePerspective()`/`aggregatePerspectives()` kept until T10.
  - `lib/agent/planning/prompts.ts` — ADD `makePlanningSystemPrompt({ targetProfitPercent })`, `PLAN_PROMPT`, `AGGREGATE_PROMPT`, `REPLAN_PROMPT` (spec §7.2-7.4).
  - Tests: wrapper maps report + stashed extras; llm fns parse mock responses; fallbacks on failure.

- [ ] **T5:** Consensus evaluation + circuit breaker + logging
  - `lib/agent/planning/evaluate.ts` — `evaluateConsensus(reports, aggregation)` → `ConsensusResult` per spec §8.1 matrix.
  - `lib/agent/planning/circuit-breaker.ts` — in-memory DD-failure (3/5min → 60s reject) + LLM-failure (5/10min → 120s reject) rules.
  - `lib/agent/planning/log.ts` — `log(level, event, data)`, DEBUG gated by NODE_ENV.
  - Tests: full decision matrix, fake timers for breaker, log level gating.

### Checkpoint: Subagent

- [ ] T4 + T5 tests pass; ReAct works with mock tools (≤5 calls); all 4 evaluation outcomes covered

---

### Phase 3: Orchestrator — 2 tasks, sequential

- [ ] **T6:** Main agent `runPlanningAgent()`
  - `lib/agent/planning/agent.ts` — Plan-Execute-Reflect loop (max 5): step 0 `runDDAgent()` (category via `getCategory(asset)`; failure → PLANNING_FAILED phase "dd"), PLAN, EXECUTE (Promise.all perspectives), AGGREGATE, EVALUATE Layer 1, RE-DEPLOY (max 2/perspective), Layer 2 `autonomyGate()`, `TradePlanSchema.parse`, non-blocking `recordDecision()`.
  - Tests: happy path ACCEPT, RE-DEPLOY→ACCEPT, NO_TRADE, FAILED, DD failure.

- [ ] **T7:** Pipeline wrapper refactor
  - `lib/agent/planning/pipeline.ts` — thin wrapper calling `runPlanningAgent()` (mirror `lib/agent/due-diligence/pipeline.ts`). New input `{ asset, userId, walletAddress, targetProfitPercent? }`.
  - `lib/agent/pipeline.ts` — verify barrel export.
  - Tests: rewritten `__tests__/lib/agent/planning/pipeline.test.ts` (new input/output shape).

### Checkpoint: Orchestrator

- [ ] T6 + T7 tests pass; full swarm runs with mocked subagents; TradePlan shape matches extended schema

---

### Phase 4: Cutover — 3 tasks, first 2 parallel

- [ ] **T8:** API route + docs
  - `app/api/agent/planning/route.ts` — new body `{ asset, userId, walletAddress, targetProfitPercent? }`; zod validation; circuit-breaker checks (tripped → 503); error contract per spec §9.6 (PLANNING_FAILED / CONSENSUS_FAILED).
  - `docs/api-documentation.md` — update planning endpoint section.
  - Tests: rewritten route test (200 happy, 400 validation, 503 breaker, 500 failure).

- [ ] **T9:** Update consumers
  - `hooks/use-planning.ts` — new body, no ddReport.
  - `components/dashboard/plan-section.tsx` — planning from `{ asset, ... }` + target profit input; disable approve when `action === "NO_TRADE"`.
  - `lib/agent/execution/pipeline.ts` — guard: NO_TRADE plan → `ExecutionError` (defensive).
  - Tests: updated where consumers are tested; full `npm test` regression pass.

- [ ] **T10:** Cleanup + final verification (after T8+T9)
  - Delete from `planning/llm.ts`: `generatePerspective`, `aggregatePerspectives`. From `prompts.ts`: `PERSPECTIVE_SYSTEM_PROMPTS`, `PERSPECTIVE_USER_PROMPT`, `AGGREGATOR_SYSTEM_PROMPT`, `AGGREGATOR_USER_PROMPT`. From `types.ts`: `PerspectiveResult`, `PlanningPipelineInput`, `AggregatedReasoning`.
  - Verify no dead imports: `rg "generatePerspective|aggregatePerspectives|PerspectiveResult|PlanningPipelineInput|AggregatedReasoning" lib app components hooks`
  - Full gate: `npm test`, `npm run lint`, `npm run typecheck`, smoke `npm run build`.

### Checkpoint: Complete

- [ ] All 11 tasks pass; zero TS/lint errors; no dead code in planning/; DD + execution tests green (no regression)

## Parallel Execution Strategy

```
Phase 0:  T0 ────┐
                 │
Phase 1:  T1 ──┼── (parallel) ──── T3        (3 agents)
                 │
Phase 2:  T4 ──┼── (parallel) ──── T5        (2 agents)
                 │
Phase 3:  T6 ──→─── T7                       (sequential)
                 │
Phase 4:  T8 ──┼── (parallel) ──── T9 ──→─── T10   (2 agents, then 1)
```

Max parallel agents: **3** (Phase 1). Total tasks: 11 (≤ 10 subagent budget per task group).

## Risks

| Risk                                                           | Impact                                      | Mitigation                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SubAgentThoughtSchema` extension breaks DD                    | DD subagent tests fail                      | All new fields optional; run full `__tests__/lib/agent/due-diligence/` after T1                                                        |
| Planning subagent never returns rich fields                    | Aggregator lacks SL/TP/leverage suggestions | Prompt requires them in return format (§7.2); wrapper defaults (0 / "no_trade") documented; aggregator falls back to risk-engine tools |
| Exa key missing → web_search always fails                      | Subagent wastes loop on failed tool         | Tool returns `success: false` fast (<100ms) with clear message; subagent continues; prompt lists it as optional                        |
| Vibe tools produce misleading numbers                          | LLM trusts approximation blindly            | Tool descriptions + result payloads label "approximation"; evaluateConsensus only uses them as signals, never as hard gates            |
| Old pipeline still referenced during refactor                  | Dead-import churn                           | Old code untouched until T10; final rg sweep                                                                                           |
| targetProfitPercent unrealistic (e.g. 5000%)                   | LLM chases impossible target                | Zod cap 1000 in route; aggregator must set `profit_feasible: false` → NO_TRADE                                                         |
| DeepSeek thinking mode latency (orchestrator 3 calls × 30-60s) | Slow API responses                          | Parallel subagents dominate time anyway; circuit breaker prevents cascade                                                              |
| ArangoDB down during recordDecision                            | Plan request fails                          | Non-blocking try/catch persistence (mirror DD recordDDReport pattern)                                                                  |

## Open Questions

All resolved — see Architecture Decisions (spec §16 mapped: 1→A6, 2→A5, 3→A5, 4→A7 pre-fetch, 5→A8, 6→A9, 7→A9, 8→A10, 9→A15/TDD-mocks).

## Documentation Standards

Every file must have:

- File-level JSDoc (`@file`, `@description`, `@module`, `@layer`) — pattern: `lib/agent/due-diligence/pipeline.ts`
- Every exported function: `@function`, `@description`, `@param`, `@returns` — pattern: `lib/agent/due-diligence/agent.ts`
- Every interface/type: `@interface`, `@description` — pattern: `lib/agent/planning/types.ts`
- Every non-trivial inline logic block: inline `// reason:` comment — pattern: `lib/agent/due-diligence/agent.ts:193`
- Zod schemas: `@constant`, `@description` — pattern: `lib/agent/types.ts:97`
- Tools: `ToolDefinition` objects need `description` on the definition AND on each Zod param (`.describe()`) — pattern: `lib/agent/tools/onchain/explorer.ts`
