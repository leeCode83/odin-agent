# Implementation Plan: Planning & Decision Agent Pipeline

**Spec:** `docs/planning-agent-spec.md` (Approved)
**Ref:** `docs/odin-spec.md` §4.2, §6, §7, §8, §9, §13, §14
**Pattern to mirror:** `docs/dd-pipeline-spec.md` (DD Agent done)

---

## Overview

Build Planning & Decision Agent — second agent in Odin's 3-agent pipeline. Hybrid LLM+code: 4 DeepSeek thinking-mode calls (3 perspective runs + 1 aggregator) + deterministic risk engine (fixed-fractional position sizing + ATR SL/TP) + ArangoDB Graph Memory queries + autonomy gating. Returns `TradePlan` with `autonomy_decision: "auto"|"approve"`.

Pipeline: validate input → resolve wallet equity (HL) → fetch candles + ATR (HL) → query graph patterns (ArangoDB) → 3 parallel perspective LLM calls (thinking mode) → 1 aggregator LLM call → deterministic risk engine → autonomy gate → return TradePlan.

Backend only. No frontend. Stops at gate decision — no Execution Agent call.

## Key Technical Decisions (from interview + spec)

1. **Entry price**: deterministic current mark price via HL `allMids` — LLM never touches
2. **Leverage**: LLM suggests, risk engine caps: `min(LLM_suggested, max_allowed)`
3. **Position size**: fixed-fractional — `riskAmount = equity * riskPct%`, contracts = riskAmount / |entry - SL|
4. **SL/TP**: ATR-based — SL = entry ± ATR * 1.5, TP = entry ± ATR * 3.0 (3:1 R:R)
5. **Self-consistency**: 3 LLM runs (conservative/balance/aggressive perspectives) via **prompt framing**, not temperature (thinking mode ignores temp)
6. **DeepSeek thinking mode**: `thinking: {"type":"enabled"}` + `reasoning_effort: "high"`, chain of thought in `reasoning_content` field
7. **Risk thresholds**: ArangoDB `risk_thresholds` per userId → env fallback
8. **Graph Memory empty state**: `graph_patterns_used=[]`, `historical_match=50` (neutral)
9. **ArangoDB unavailable**: non-fatal — continue with empty patterns
10. **Pipeline timeout**: 90s hard deadline (thinking mode slower)

## Module Dependency Graph

```
lib/agent/types.ts ─── ADD TradePlan, RiskThresholds, etc. ───── (phase 1)
lib/db/arango-types.ts ─── ArangoDB doc types ─────────────────── (phase 1)
lib/agent/planning/types.ts ─── internal LLM/pipeline types ───── (phase 1)
     │
     ├── lib/db/arango-client.ts ─── ArangoDB singleton ──────── (phase 2, dep: arango-types)
     │        │
     │        ├── lib/db/risk-thresholds.ts ── getRiskThresholds (phase 2)
     │        └── lib/db/graph-memory.ts ──── queryGraphPatterns (phase 2)
     │
     ├── lib/data/hyperliquid.ts ─── ADD fetchMarkPrice, etc. ── (phase 2)
     │
     ├── lib/agent/planning/prompts.ts ─── 4 prompt sets ──────── (phase 2)
     ├── lib/agent/planning/risk-engine.ts ── ATR + sizing ────── (phase 2)
     ├── lib/agent/planning/gate.ts ─── autonomy gate ──────────── (phase 2)
     │
     ├── lib/agent/planning/llm.ts ─── thinking-mode calls ────── (phase 2, dep: prompts)
     │
     └── lib/agent/planning/pipeline.ts ─── orchestrator ──────── (phase 3, dep: ALL above)
          └── app/api/agent/planning/route.ts ─── POST handler ── (phase 3)
```

## Architecture Decisions

1. **Types split**: Shared inter-agent types (TradePlan, RiskThresholds) → `lib/agent/types.ts`. Planning-internal types → `lib/agent/planning/types.ts`. Following existing DD pattern (DDReport in shared, pipeline I/O in internal).
2. **DB layer**: New `lib/db/` directory for ArangoDB shared infra — used by Planning Agent now, Execution Agent later. `arango-client.ts` singleton + `risk-thresholds.ts` + `graph-memory.ts`.
3. **Test framework**: Vitest (same as DD Agent). `vi.mock()` at module level for all external deps (openai, @nktkas/hyperliquid, arangojs).
4. **TDD per file**: Each subagent writes failing test (RED) → minimal implementation (GREEN) → verify.
5. **Error pattern**: Every module throws typed errors; pipeline catches and maps to `errors[]` — never crashes. ArangoDB down → empty graph patterns. LLM failure per perspective → null perspective result. All 3 perspectives fail → 500.
6. **New dependency**: `arangojs` (`npm install arangojs`).

## Parallel Work Streams

### Phase 0: Foundation (Main Agent — sequential)
Install arangojs, create directories.

### Phase 1: Types Foundation (3 parallel subagents)
Write shared types + Zod schemas that all other modules depend on.

### Phase 2: Implementation (6 parallel subagents)
All independent modules — each writes test first then implementation.

### Phase 3: Pipeline Integration (Main Agent — sequential)
Orchestrator + API route. Depends on all phase 2 modules.

### Phase 4: Verify (Main Agent)
Run full test suite + lint + typecheck.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| DeepSeek thinking mode latency | >30s per call, 4 calls = 2min | 90s hard timeout. Perspective calls parallel (3 simultaneous). Aggregator after. |
| ArangoDB not installed locally | DB layer tests fail | Mock arangojs in all tests. Real query only at pipeline integration. |
| @nktkas/hyperliquid SDK API changes | fetchMarkPrice/fetchUserEquity break | Double-check method names via context7 before implementing. Mock in tests. |
| Zod v4 `z.record()` 2-arg requirement | Schema breaks | Already handled in DD Agent. Follow same pattern: `z.record(z.enum([...]), schema)`. |
| Shared types merge conflicts | lib/agent/types.ts edited by subagent + existing content conflict | Subagent MUST append, not overwrite. Existing DD types preserved. |
