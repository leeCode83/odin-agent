# Spec: Due Diligence Agent Pipeline

> **Status:** Approved
> **Ref:** `docs/odin-spec.md` §4.1, §7, §12, §14

---

## 1. Objective

Build the Due Diligence (DD) Agent — the first agent in Odin's agent pipeline (DD → Planning → paper trading; live execution tidak lagi di scope). DD Agent takes an asset ticker as input, fetches multi-factor market data from free APIs, runs per-factor LLM analysis via DeepSeek, aggregates into a structured DD Report, and returns it to the Planning & Decision Agent.

**Success criteria:**
- Given any Hyperliquid-listed asset, produce a valid `DDReport` JSON within 30 seconds
- All 4 analysis factors designed; technical + onchain implemented first (MVP), sentiment + fundamental as stretch
- Multi-pass LLM: 1 call per active factor + 1 aggregation call = up to 5 DeepSeek API calls per asset
- Pipeline triggered on-demand (API route / server action), no cron scheduler in this spec

---

## 2. Data Flow

```
Trigger (API route)
      │
      ▼
  resolveCategory(asset)  ──► CategoryConfig { activeSections }
      │
      ├──► fetchTechnical(asset)    ──► technical raw data
      ├──► fetchOnchain(asset)      ──► onchain raw data
      ├──► fetchSentiment(asset)    ──► sentiment raw data (stretch)
      ├──► fetchFundamental(asset)  ──► fundamental raw data (stretch)
      │
      ▼   (parallel fetch, Promise.all)
  Per-factor LLM calls (only active sections)
      ├──► analyzeTechnical(raw)    ──► SectionResult { score, summary, signals }
      ├──► analyzeOnchain(raw)      ──► SectionResult
      ├──► analyzeSentiment(raw)    ──► SectionResult (stretch)
      ├──► analyzeFundamental(raw)  ──► SectionResult (stretch)
      │
      ▼   (sequential after all sections done)
  Aggregate LLM call
      └──► synthesize(sections)     ──► DDReport { aggregated_thesis, confidence_score, risk_flags }
      │
      ▼
  Return DDReport (validated against Zod schema)
```

Key constraints:
- Inactive sections (e.g. `fundamental` for meme coins) get `{ score: null, summary: null, signals: [] }` without an LLM call
- Fetch calls run in parallel; LLM calls run in parallel per factor; aggregation runs after all factors complete
- Max total time target: 30s (fetch ≤10s, 5× LLM calls ≤20s combined)

---

## 3. Data Sources

### 3.1 Primary: Hyperliquid Info API (via `@nktkas/hyperliquid` SDK)

SDK provides `InfoClient` — all calls use `hl.InfoClient` on `https://api.hyperliquid-testnet.xyz/info` (testnet first).

| Data Point | SDK Method | Used For |
|---|---|---|
| OHLCV candles | `infoClient.candleSnapshot({ coin, interval, startTime, endTime })` | Technical |
| Asset contexts | `infoClient.metaAndAssetCtxs()` | Onchain |
| Funding history | `infoClient.fundingHistory({ coin, startTime, endTime })` | Onchain |
| OI cap status | `infoClient.perpsAtOpenInterestCap()` | Onchain |

**Candle intervals used:** `1h`, `15m`, `1d`
**Lookback window:** 72 hours for 1h candles, 24 hours for 15m, 30 days for 1d

### 3.2 Secondary: CoinGecko Keyless API

Free tier, no API key. Base: `https://api.coingecko.com/api/v3`

| Data Point | Endpoint | Used For |
|---|---|---|
| Current price + 24h change | `/simple/price?ids={id}&vs_currencies=usd&include_24hr_change=true` | Technical / Fundamental |
| Market data (cap, volume, supply) | `/coins/markets?vs_currency=usd&ids={id}` | Fundamental |
| Historical OHLC | `/coins/{id}/ohlc?vs_currency=usd&days=7` | Technical (fallback) |
| Trends | `/search/trending` | Sentiment |
| Global stats | `/global` | Sentiment (market sentiment proxy) |
| Coin metadata | `/coins/{id}?localization=false&tickers=false&community_data=true&developer_data=true` | Fundamental |

### 3.3 Tertiary: Alternative.me Fear & Greed Index

No auth. `GET https://api.alternative.me/fng/`

Returns:
```json
{ "name": "Fear and Greed Index", "data": [{ "value": "45", "value_classification": "Fear", "timestamp": "..." }] }
```
Used for: sentiment (market-wide fear/greed metric)

### 3.4 Asset ID Mapping

CoinGecko uses coin IDs (not tickers). Maintain a lookup map:

```ts
const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", SUI: "sui",
  AVAX: "avalanche-2", UNI: "uniswap", AAVE: "aave", LINK: "chainlink",
  DOGE: "dogecoin", PEPE: "pepe", WIF: "dogwifcoin",
};
```

### 3.5 Rate Limit Strategy

| API | Limit | Mitigation |
|---|---|---|
| Hyperliquid Info | ~1200 req/min | Sufficient for DD; no special handling needed |
| CoinGecko Keyless | ~10-30 req/min (unspecified) | In-memory cache per asset with 60s TTL |
| Alternative.me | Not documented | Cache 300s TTL (market-wide, not per asset) |

---

## 4. LLM Integration

### 4.1 Model & Client

- **Model:** `deepseek-v4-flash`
- **Mode:** Non-thinking (default — no `reasoning_effort` or `thinking` body)
- **Client:** `openai` npm package configured with `baseURL: "https://api.deepseek.com"`
- **API Key:** `DEEPSEEK_API_KEY` env var

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});
```

### 4.2 Per-Factor LLM Call

Each active factor gets one call with the same parameter template:

```ts
const response = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  temperature: 0.3,
  max_tokens: 1024,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: FACTOR_SYSTEM_PROMPTS[factor] },
    { role: "user", content: JSON.stringify(rawData) },
  ],
});
```

Each call returns parsed `SectionResult`:
```json
{ "score": 72, "summary": "...", "signals": ["RSI oversold", "MACD bullish crossover"] }
```

### 4.3 Aggregation LLM Call

After all per-factor calls complete:

```ts
const response = await client.chat.completions.create({
  model: "deepseek-v4-flash",
  temperature: 0.3,
  max_tokens: 2048,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: AGGREGATION_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ asset, category, sections }) },
  ],
});
```

Returns:
```json
{
  "aggregated_thesis": "...",
  "confidence_score": 78,
  "risk_flags": ["high funding cost", "low 24h volume"]
}
```

### 4.4 Prompt Strategy

System prompts stored as constants in `lib/agent/prompts.ts`. Per-factor prompts instruct the LLM to:
- Score 0–100
- List 1–5 specific signals with direction (bullish/bearish)
- Write a 2–3 sentence summary
- Return valid JSON matching the expected `SectionResult` shape

Aggregation prompt instructs the LLM to:
- Synthesize across sections into a unified thesis
- Score confidence 0–100 based on factor alignment
- Flag any risk concerns (high funding, low liquidity, volatility spike, etc.)
- Return valid JSON matching the aggregation shape

### 4.5 Error Handling for LLM

| Error | Strategy |
|---|---|
| JSON parse failure | Retry once with explicit "Output ONLY valid JSON" instruction; if still fails, set `score: 0, summary: "LLM parse error"` |
| API timeout (10s) | Retry once; if retry also times out, mark section as error |
| Rate limit (429) | Exponential backoff: 1s → 2s → 4s; max 3 retries |
| 5xx server error | Retry once; after 2 failures, skip section and flag in risk_flags |

---

## 5. Output Schema (DD Report)

The DD Agent output is a `DDReport` matching odin-spec §7, validated with Zod:

```ts
import { z } from "zod";

const SectionResultSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  summary: z.string().nullable(),
  signals: z.array(z.string()),
});

const SectionKey = z.enum(["technical", "onchain", "sentiment", "fundamental"]);

const DDReportSchema = z.object({
  asset: z.string(),
  category: z.string(),
  timestamp: z.string().datetime(),
  sections: z.record(SectionKey, SectionResultSchema),
  aggregated_thesis: z.string(),
  confidence_score: z.number().int().min(0).max(100),
  risk_flags: z.array(z.string()),
  errors: z.array(z.string()).optional(), // non-fatal errors encountered
});

type DDReport = z.infer<typeof DDReportSchema>;
type SectionResult = z.infer<typeof SectionResultSchema>;
```

Example output:
```json
{
  "asset": "BTC",
  "category": "major",
  "timestamp": "2026-07-16T10:00:00Z",
  "sections": {
    "technical": { "score": 72, "summary": "BTC showing bullish momentum on 1h...", "signals": ["RSI oversold reversal", "MACD bullish crossover", "Price above 50 EMA"] },
    "onchain": { "score": 65, "summary": "Funding neutral, OI increasing...", "signals": ["Funding rate neutral", "Open interest rising", "No OI cap risk"] },
    "sentiment": { "score": null, "summary": null, "signals": [] },
    "fundamental": { "score": null, "summary": null, "signals": [] }
  },
  "aggregated_thesis": "BTC menunjukkan setup bullish moderat dengan konfirmasi teknikal...",
  "confidence_score": 78,
  "risk_flags": [],
  "errors": []
}
```

---

## 6. TypeScript Interfaces

### 6.1 Core Domain Types

```ts
// lib/agent/types.ts

type Factor = "technical" | "onchain" | "sentiment" | "fundamental";
type SectionScore = number | null; // 0-100 or null if N/A

interface SectionResult {
  score: SectionScore;
  summary: string | null;
  signals: string[];
}

interface DDReport {
  asset: string;
  category: string;
  timestamp: string;
  sections: Record<Factor, SectionResult>;
  aggregated_thesis: string;
  confidence_score: number;
  risk_flags: string[];
  errors?: string[];
}

interface DDPipelineInput {
  asset: string;   // ticker, e.g. "BTC"
  userId: string;  // wallet address
}

interface DDPipelineOutput {
  report: DDReport;
  timing: {
    fetchMs: number;
    llmMs: number;
    totalMs: number;
  };
}
```

### 6.2 Data Provider Interfaces

```ts
// lib/data/types.ts

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OnchainData {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  oraclePrice: number;
  premium: number | null;
  dayVolume: number;
  oiCapReached: boolean;
}

interface SentimentData {
  fearGreedIndex: number | null;
  fearGreedClassification: string | null;
  trendingRank: number | null;
}

interface FundamentalData {
  marketCap: number | null;
  totalVolume24h: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  athPrice: number | null;
  athChangePercent: number | null;
  description: string | null;
}

interface RawFactorData {
  technical: {
    candles1h: CandleData[];
    candles15m: CandleData[];
    candles1d: CandleData[];
    currentPrice: number;
    priceChange24h: number;
  };
  onchain: OnchainData;
  sentiment: SentimentData;
  fundamental: FundamentalData;
}
```

### 6.3 Category Config (from `lib/asset-categories.ts`)

```ts
interface CategoryConfig {
  activeSections: Factor[];
}
```

---

## 7. File & Module Structure

```
lib/
├── agent/
│   ├── types.ts            # DDReport, SectionResult, DDPipelineInput/Output
│   ├── pipeline.ts         # runDDPipeline(input) → main orchestrator
│   ├── prompts.ts          # FACTOR_SYSTEM_PROMPTS, AGGREGATION_SYSTEM_PROMPT
│   └── llm.ts              # analyzeSection(factor, data), synthesizeSections(sections)
├── data/
│   ├── types.ts            # CandleData, OnchainData, SentimentData, FundamentalData, RawFactorData
│   ├── providers.ts        # fetchAllRawData(asset, category) → RawFactorData
│   ├── hyperliquid.ts      # HL data fetcher (candles, OI, funding)
│   ├── coingecko.ts        # CG data fetcher (price, market, trends, metadata)
│   └── sentiment.ts        # Fear & Greed fetcher (stretch)
├── asset-categories.ts     # getCategory(asset) → CategoryConfig
└── cache.ts                # in-memory cache with TTL (for rate limit mitigation)

app/
└── api/
    └── agent/
        └── dd/
            └── route.ts    # POST /api/agent/dd — trigger DD pipeline
```

---

## 8. Pipeline Orchestration

### 8.1 `runDDPipeline(input: DDPipelineInput): Promise<DDPipelineOutput>`

```ts
// lib/agent/pipeline.ts

export async function runDDPipeline(input: DDPipelineInput): Promise<DDPipelineOutput> {
  const t0 = Date.now();

  // 1. Resolve category
  const category = getCategory(input.asset);
  if (!category) throw new Error(`Unknown asset: ${input.asset}`);

  // 2. Fetch raw data (parallel, only fetch what's needed)
  const fetchStart = Date.now();
  const rawData = await fetchAllRawData(input.asset, category);
  const fetchMs = Date.now() - fetchStart;

  // 3. Per-factor LLM analysis (parallel, only active sections)
  const llmStart = Date.now();
  const sectionPromises = category.activeSections.map((factor) =>
    analyzeSection(factor, rawData[factor])
  );
  const sectionResults = await Promise.all(sectionPromises);

  // Build sections map (inactive = null)
  const sections: Record<Factor, SectionResult> = {
    technical:  { score: null, summary: null, signals: [] },
    onchain:    { score: null, summary: null, signals: [] },
    sentiment:  { score: null, summary: null, signals: [] },
    fundamental:{ score: null, summary: null, signals: [] },
  };
  category.activeSections.forEach((factor, i) => {
    sections[factor] = sectionResults[i];
  });

  // 4. Aggregation LLM call
  const { thesis, confidence, flags, errors } = await synthesizeSections(
    input.asset, category, sections
  );

  const llmMs = Date.now() - llmStart;

  // 5. Assemble report
  const report: DDReport = {
    asset: input.asset,
    category: getCategoryName(input.asset), // e.g. "major"
    timestamp: new Date().toISOString(),
    sections,
    aggregated_thesis: thesis,
    confidence_score: confidence,
    risk_flags: flags,
    errors,
  };

  return {
    report,
    timing: { fetchMs, llmMs, totalMs: Date.now() - t0 },
  };
}
```

### 8.2 API Route

```ts
// app/api/agent/dd/route.ts
import { NextRequest, NextResponse } from "next/server";
import { runDDPipeline } from "@/lib/agent/pipeline";
import { DDReportSchema } from "@/lib/agent/types";

export async function POST(req: NextRequest) {
  const { asset, userId } = await req.json();

  if (!asset || !userId) {
    return NextResponse.json({ error: "asset and userId required" }, { status: 400 });
  }

  try {
    const output = await runDDPipeline({ asset, userId });
    const parsed = DDReportSchema.parse(output.report);
    return NextResponse.json({ ...output, report: parsed });
  } catch (err) {
    console.error("DD pipeline error:", err);
    return NextResponse.json(
      { error: "DD pipeline failed", detail: String(err) },
      { status: 500 }
    );
  }
}
```

---

## 9. Error Handling & Resilience

### 9.1 Per-Source Degradation

If a data source fails, the pipeline must NOT fail entirely. Strategy:

| Source Failure | Handling |
|---|---|
| Hyperliquid down | Flag in `errors[]`, set onchain section to `{ score: null, summary: "HL API unavailable", signals: [] }`, continue with CG technical data |
| CoinGecko rate limited | Use cached data if available; if no cache, skip fundamental+trending, note in errors |
| Alternative.me down | Fear & Greed = null (sentiment already stretch) |
| All sources down | Return error response (500), do NOT fabricate data |

### 9.2 Partial Report Validity

A report with 1–2 factor sections at null is still valid. Planning Agent should handle partial reports by lowering confidence weight on missing sections.

### 9.3 Timeouts

- Each data fetch: 5s timeout
- Each LLM call: 10s timeout
- Pipeline total: 45s timeout (hard deadline)

---

## 10. Commands

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run lint --fix` | Auto-fix lint issues |

No new dependencies to add yet — `@nktkas/hyperliquid`, `openai`, `zod` already part of planned tech stack; add when implementing.

---

## 11. Implementation Phases

### Phase 1: Scaffold (MVP Core)
- `lib/asset-categories.ts` — category resolution
- `lib/agent/types.ts` — all type defs
- `lib/data/types.ts` — raw data types
- `lib/data/hyperliquid.ts` — candleSnapshot, metaAndAssetCtxs, fundingHistory fetchers
- `lib/agent/prompts.ts` — technical + onchain system prompts
- `lib/agent/llm.ts` — per-factor LLM call + aggregation call
- `lib/agent/pipeline.ts` — orchestrator
- `app/api/agent/dd/route.ts` — POST endpoint

**Checkpoint:** Run pipeline for BTC → valid DDReport with technical + onchain sections.

### Phase 2: Secondary Data (MVP Complete)
- `lib/data/coingecko.ts` — price, market chart, metadata fetchers
- `lib/cache.ts` — in-memory cache
- Enrich technical/onchain with CG fallback data

**Checkpoint:** Pipeline runs for any category; onchain has funding+OI data.

### Phase 3: Sentiment + Fundamental (Stretch)
- `lib/data/sentiment.ts` — Fear & Greed + CG trending
- `lib/agent/prompts.ts` — add sentiment + fundamental system prompts
- Full 4-factor pipeline with correct active/inactive per category

**Checkpoint:** Meme coins skip fundamental; majors get full 4-factor report.

---

## 12. Testing Strategy

- **Unit tests:** Category resolution, data fetcher mocks, LLM call with mock OpenAI client, JSON schema validation
- **Integration test:** Full pipeline run against Hyperliquid testnet for 1 asset (BTC)
- **No E2E at this stage** — dashboard integration comes later

Test commands: `npx vitest` or `npx jest` (TBD after package setup).

---

## 13. Boundaries

- **Always:** Validate LLM output against Zod schema before returning; log every pipeline run with timing; handle errors per-source without crashing pipeline
- **Ask first:** Adding new npm dependencies; changing DD Report schema fields; changing DeepSeek model choice (v4-flash vs v4-pro)
- **Never:** Hardcode API keys; store raw LLM responses without validation; skip Zod validation on output

---

## 14. Resolved Decisions

1. **DeepSeek API key management** — Single project key for MVP. Stored in `DEEPSEEK_API_KEY` env var. Per-user keys deferred to post-MVP.

2. **Prompt quality** — Developer writes system prompts for each LLM call. Prompts live in `lib/agent/prompts.ts` as constants. No A/B testing framework needed for MVP; iterate manually.

3. **CoinGecko ID mapping** — Developer manually updates `COINGECKO_ID` map in `lib/asset-categories.ts` when new assets are added to watchlist. No automated sync for MVP.

4. **Sentiment news source** — Use Alternative.me Fear & Greed Index + CoinGecko Trending as the sole sentiment data sources for MVP. No external news/headline API. Rationale: (a) Fear & Greed is market-wide sentiment with zero auth, (b) Trending shows asset-level attention, (c) cryptocurrency.cv requires API key or x402 payment — violates "demo-friendly free APIs" constraint. If news sentiment proves valuable, add a free RSS parser (CoinDesk/Cointelegraph) in post-MVP stretch.

---

*Spec relates to: `docs/odin-spec.md` §4.1 (DD Agent), §7 (DD Report format), §12 (Kategorisasi Aset), §14 (LLM Model), §17 (Tech Stack), §18 (MVP Scope)*
