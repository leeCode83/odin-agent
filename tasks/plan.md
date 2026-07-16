# Implementation Plan: Due Diligence Agent Pipeline

## Overview

Build DD Agent pipeline per `docs/dd-pipeline-spec.md`. 3-agent pipeline (DD → Planning → Execution); this covers agent #1.

Pipeline: resolveCategory → parallel fetch (HL + CG) → parallel per-factor LLM → sequential aggregation → return DDReport.

## Tech Stack Verification (Context7)

- **DeepSeek API**: `deepseek-v4-flash` confirmed. OpenAI SDK `client.chat.completions.create()` confirmed. `response_format: { type: "json_object" }` confirmed. Non-thinking default = no `thinking`/`reasoning_effort` body.
- **Hyperliquid SDK** (`@nktkas/hyperliquid`): `HttpTransport` + `InfoClient` confirmed. `candleSnapshot({ coin, interval, startTime, endTime })` confirmed. `metaAndAssetCtxs()`, `fundingHistory({ coin, startTime, endTime })` confirmed.
- **Zod v4**: `z.infer` confirmed. `z.record()` requires 2 args (keys + values) in v4 — spec already correct.
- **Next.js App Router**: `@/*` path alias to root confirmed via tsconfig.json.

## Module Dependency Graph

```
lib/agent/types.ts ──────────────────────────── (no deps)
lib/data/types.ts ───────────────────────────── (no deps)
lib/asset-categories.ts ─────────────────────── (no deps)
     │
     ├── lib/data/hyperliquid.ts ────────────── (dep: lib/data/types.ts)
     ├── lib/data/coingecko.ts ──────────────── (dep: lib/data/types.ts, lib/asset-categories.ts)
     ├── lib/cache.ts ───────────────────────── (no deps)
     ├── lib/agent/prompts.ts ───────────────── (no deps)
     │
     ├── lib/data/providers.ts ──────────────── (dep: all data/*, cache)
     ├── lib/agent/llm.ts ───────────────────── (dep: lib/agent/types.ts, lib/agent/prompts.ts)
     │
     ├── lib/agent/pipeline.ts ──────────────── (dep: ALL previous)
     └── app/api/agent/dd/route.ts ──────────── (dep: lib/agent/pipeline.ts)
```

## Architecture Decisions

1. **Test framework**: Vitest. Zero-config, native TypeScript, fast. No Jest dependency.
2. **Mock strategy**: `vi.mock()` at module level for `openai` and `@nktkas/hyperliquid`. Global fetch mock via `vi.stubGlobal()` for CG + Alt.me calls.
3. **TDD per file**: Each file gets RED (write failing test) → GREEN (min impl) → POLISH (refactor) within same subagent session.
4. **No test for `route.ts`**: API route wraps pipeline; integration tested via pipeline. Unit test pipeline directly.
5. **Phase 1 only**: Technical + onchain factors. Sentiment + fundamental stubs return null (stretch deferred).
6. **Error pattern**: Every module throws typed errors; pipeline catches and maps to `errors[]` + null sections — never crashes.

## Parallel Work Streams

### Phase 0: Foundation (sequential, main agent)
Install deps (`@nktkas/hyperliquid`, `openai`, `zod`, `vitest` + `@types/node`). Create `.env.local.example`. Create `lib/` directories.

### Phase 1: RED — All tests (6 parallel subagents)
Each subagent writes failing tests for ONE module area.

### Phase 2: GREEN — All implementation (6 parallel subagents)
Each subagent implements code to make their tests pass.

### Phase 3: POLISH — Refactor + verify (6 parallel subagents)
Each subagent cleans up, ensures `tsc --noEmit` passes, adds error handling.

### Checkpoint: Integration (main agent)
Run full `vitest run`, `tsc --noEmit`, `npm run lint`.
Edit `app/page.tsx` to show a "DD Agent Test" button that calls `/api/agent/dd` with asset=BTC.
Verify DDReport shape in browser console.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| CoinGecko rate limit during test | Tests flaky | Mock all CG calls — no real HTTP in unit tests |
| Hyperliquid testnet down | Pipeline fails | Tests mock HL; real run not yet in scope |
| DeepSeek API key not set | LLM calls fail | Graceful degradation: section = null if LLM is missing key |
| Zod v4 `z.record()` 2-arg requirement | Schema breaks in v4 | Use `z.enum(["technical",...]).pipe(z.record(...))` or correct v4 syntax |
| Next.js 16 + vitest compat | Config issues | Use `vitest.config.ts` with `environment: 'node'` (no jsdom needed) |
