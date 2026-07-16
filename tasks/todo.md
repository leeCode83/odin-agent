# DD Agent Pipeline — Task List

**Plan:** `tasks/plan.md`
**Spec:** `docs/dd-pipeline-spec.md`

---

## Phase 0: Foundation (Main Agent — sequential)

- [ ] Install dependencies: `npm install @nktkas/hyperliquid openai zod vitest @types/node`
- [ ] Create `lib/agent/`, `lib/data/` directories
- [ ] Create `.env.local` with `DEEPSEEK_API_KEY=`
- [ ] Add `"test": "vitest run"` and `"typecheck": "tsc --noEmit"` to package.json scripts
- [ ] Create `vitest.config.ts` with `environment: 'node'`

---

## Phase 1-3: Parallel Work Streams (6 Subagents)

Each subagent does RED → GREEN → POLISH within their module.

### Subagent A — Asset Categories + COINGECKO_ID Map

**Files:**
- `lib/asset-categories.ts` — `getCategory(asset)`, `getCategoryName(asset)`, `getCoinGeckoId(asset)`, `COINGECKO_ID` map

**Acceptance:**
- `getCategory("BTC")` returns `{ name: "major", activeFactors: ["technical","onchain","sentiment","fundamental"] }`
- `getCategory("PEPE")` returns `{ name: "meme", activeFactors: ["technical","onchain","sentiment"] }` (no fundamental)
- `getCategory("UNKNOWN")` falls back to `major`
- `getCoinGeckoId("BTC")` returns `"bitcoin"`

**RED (test file):** `__tests__/lib/asset-categories.test.ts`
**GREEN:** Implement `lib/asset-categories.ts`
**POLISH:** Add edge cases, ensure `tsc --noEmit` passes

**Dependencies:** None
**Verification:** `npx vitest run __tests__/lib/asset-categories.test.ts`

---

### Subagent B — Core Types + Zod Schemas

**Files:**
- `lib/agent/types.ts` — `Factor`, `SectionResult`, `DDReport`, `DDPipelineInput`, `DDPipelineOutput`, `SectionResultSchema`, `DDReportSchema`
- `lib/data/types.ts` — `CandleData`, `OnchainData`, `SentimentData`, `FundamentalData`, `RawFactorData`

**Acceptance:**
- `DDReportSchema.parse(validReportObj)` succeeds
- `DDReportSchema.parse(invalidReportObj)` throws
- TypeScript types compile (no implicit any)
- `SECTION_KEYS` enum exports all 4 factors

**RED (test file):** `__tests__/lib/agent/types.test.ts`
**GREEN:** Implement both files
**POLISH:** Add `z.infer` exports, ensure Zod v4 compatibility (`z.record` with 2 args)

**Dependencies:** None
**Verification:** `npx vitest run __tests__/lib/agent/types.test.ts`

---

### Subagent C — Hyperliquid Data Fetcher

**Files:**
- `lib/data/hyperliquid.ts` — `createHLClient()`, `fetchCandles(asset)`, `fetchOnchainData(asset)`, `fetchAllHLData(asset)`

**Acceptance:**
- `fetchCandles("BTC")` returns `CandleData[]` with 1h, 15m, 1d intervals
- `fetchOnchainData("BTC")` returns `OnchainData` with funding, OI, mark price
- Failure returns structured error, never throws unhandled
- Uses `InfoClient` from `@nktkas/hyperliquid` via `HttpTransport`

**RED (test file):** `__tests__/lib/data/hyperliquid.test.ts` — mock `InfoClient`
**GREEN:** Implement `lib/data/hyperliquid.ts`
**POLISH:** 5s timeout per call, error wrapping, testnet URL config

**Dependencies:** B (types)
**Verification:** `npx vitest run __tests__/lib/data/hyperliquid.test.ts`

---

### Subagent D — CoinGecko + Cache + Sentiment

**Files:**
- `lib/data/coingecko.ts` — `fetchPrice(asset)`, `fetchTrending()`, `fetchMetadata(asset)`
- `lib/cache.ts` — `Cached<T>` class with TTL, `get(key)`, `set(key, value, ttlMs)`, `has(key)`
- `lib/data/sentiment.ts` — `fetchFearGreedIndex()`

**Acceptance:**
- `fetchPrice("BTC")` returns `{ usd: number, change24h: number | null }`
- `fetchTrending()` returns ranked asset tickers
- Cache with 60s TTL for CG, 300s TTL for fear/greed
- Cache hit returns without network call
- All fetch failures return null (non-fatal)

**RED (test files):** `__tests__/lib/data/coingecko.test.ts`, `__tests__/lib/cache.test.ts`
**GREEN:** Implement all 3 files
**POLISH:** Cache expiry test, CG rate limit handling

**Dependencies:** B (types), A (COINGECKO_ID)
**Verification:** `npx vitest run __tests__/lib/data/coingecko.test.ts __tests__/lib/cache.test.ts`

---

### Subagent E — LLM Integration (Prompts + Client)

**Files:**
- `lib/agent/prompts.ts` — `SYSTEM_PROMPTS[factor]`, `AGGREGATION_PROMPT`
- `lib/agent/llm.ts` — `createLLMClient()`, `analyzeSection(factor, rawData)`, `synthesizeSections(asset, category, sections)`

**Acceptance:**
- `analyzeSection("technical", rawData)` returns `SectionResult` with valid structure
- `synthesizeSections(...)` returns `{ thesis, confidence, flags, errors }`
- Missing API key → section returns null (graceful degradation), not crash
- JSON parse failure retries once, then returns default null section
- `response_format: "json_object"` enforced in calls

**RED (test file):** `__tests__/lib/agent/llm.test.ts` — mock OpenAI client
**GREEN:** Implement both files
**POLISH:** 10s timeout per LLM call, retry logic, `process.env.DEEPSEEK_API_KEY` validation

**Dependencies:** B (types)
**Verification:** `npx vitest run __tests__/lib/agent/llm.test.ts`

---

### Subagent F — Data Providers Orchestrator

**Files:**
- `lib/data/providers.ts` — `fetchAllRawData(asset, category)` mapping factor → correct fetcher

**Acceptance:**
- `fetchAllRawData("BTC", majorCategory)` calls HL + CG, returns complete `RawFactorData`
- Only fetches data for `category.activeFactors` (skip fundamental for meme)
- Partial failure produces partial data (HL up but CG down → onchain filled, fundamental null)
- All 4 factor data types present in return, with nulls for skipped/unavailable

**RED (test file):** `__tests__/lib/data/providers.test.ts` — mock sub-fetchers
**GREEN:** Implement `lib/data/providers.ts`
**POLISH:** Timing tracking, error aggregation

**Dependencies:** C, D (data fetchers)
**Verification:** `npx vitest run __tests__/lib/data/providers.test.ts`

---

## After All Subagents Complete

### Checkpoint: Integration (Main Agent)

- [ ] Run `npx vitest run` — all tests pass
- [ ] Run `npx tsc --noEmit` — no type errors
- [ ] Run `npm run lint` — no lint errors

### Phase 4: Pipeline + API Route + Demo UI

**Files:**
- `lib/agent/pipeline.ts` — `runDDPipeline(input)` orchestrator
- `app/api/agent/dd/route.ts` — `POST /api/agent/dd`
- `app/page.tsx` — demo test button

**Acceptance:**
- `runDDPipeline({ asset: "BTC", userId: "test" })` returns valid `DDPipelineOutput`
- POST `/api/agent/dd` with `{ asset, userId }` returns 200 + DDReport
- POST `/api/agent/dd` with missing fields returns 400
- Demo page has button that calls API and shows report JSON

**Verification:**
- `npx vitest run`
- Manual: run `npm run dev`, open page, click button, check console for valid DDReport
- `npm run build`

### Final Checks

- [ ] Full test suite passes: `npx vitest run`
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] Lint passes: `npm run lint`
- [ ] Build passes: `npm run build`
- [ ] Pipeline produces DDReport for BTC (major) and DOGE (meme, skips fundamental)
