# DD Agent Refactor Spec

Convert linear pipeline → multi-agent swarm dengan ReAct loop.

---

## 1. Motivation

**Current:** `runDDPipeline()` di `lib/agent/due-diligence/pipeline.ts` adalah linear pipeline:
`getCategory → fetchAllRawData (parallel) → per-factor analyzeSection (LLM) → synthesizeSections (LLM)`.
Semua data di-fetch upfront, LLM tidak bisa decide tools mana yang dipanggil, tidak bisa
re-act berdasarkan intermediate results, tidak bisa cross-verify antar factor.

**Target:** Multi-agent swarm dimana setiap factor punya agent sendiri dengan ReAct loop,
main agent mengkoordinasi via Plan-Execute-Reflect. Agent bisa decide tools apa yang dipanggil,
bisa re-deploy subagent jika confidence rendah, bisa cross-verify antar factor.

---

## 2. Architecture: Tool-Swarm Pattern

```
POST /api/agent/dd { asset, userId, walletAddress }
  ↓
DDAgentMain.run()
  ↓
  ┌─ PLAN ─────────────────────────────────────────┐
  │ LLM: buat rencana — subagent mana, prioritas,   │
  │      instruksi spesifik per subagent            │
  └────────────────────────────────────────────────┘
  ↓
  ┌─ EXECUTE (parallel) ───────────────────────────┐
  │ ┌─ TechnicalSubAgent ──── FactorReport ─┐      │
  │ │ ReAct loop, max 3, tools: technicalindicators+HL candles      │
  │ └───────────────────────────────────────┘      │
  │ ┌─ OnchainSubAgent ────── FactorReport ─┐      │
  │ │ ReAct loop, max 3, tools: HL+DeFiLlama│      │
  │ │ +CG+explorer                          │      │
  │ └───────────────────────────────────────┘      │
  │ ┌─ SentimentSubAgent ──── FactorReport ─┐      │
  │ │ ReAct loop, max 3, tools: crypto.cv   │      │
  │ │ +AltMe                                │      │
  │ └───────────────────────────────────────┘      │
  │ ┌─ FundamentalSubAgent ── FactorReport ─┐      │
  │ │ ReAct loop, max 3, tools: CG+PublicD  │      │
  │ └───────────────────────────────────────┘      │
  └────────────────────────────────────────────────┘
  ↓
  ┌─ AGGREGATE ────────────────────────────────────┐
  │ LLM: merge 4 FactorReports → thesis,           │
  │      crossValidation, risks, catalysts         │
  │ Deterministic: overallScore, overallConfidence  │
  └────────────────────────────────────────────────┘
  ↓
  ┌─ EVALUATE ─────────────────────────────────────┐
  │ Check: missing fields, low confidence,          │
  │        contradictory data antar factor          │
  │ Decision: ACCEPT / RE-DEPLOY / PARTIAL / FAIL  │
  └────────────────────────────────────────────────┘
  ↓ (RE-DEPLOY)
  └→ Re-deploy subagent specific dengan instruksi baru
     (misal: "confidence technical rendah, coba fetch
      sumber berbeda atau timeframe berbeda")
  ↓ (ACCEPT)
  └→ Return DDReport, persist ke ArangoDB
```

---

## 3. Agent Loops

### 3.1 SubAgent: ReAct

```
LOOP (max 3):
  1. THINK:  LLM terima factor + daftar tool yang tersedia
             → decide: tool apa, parameter apa
  2. ACT:    Execute tool dengan parameter yang dipilih LLM
  3. OBSERVE: Parse hasil tool ke context window
  4. REFLECT: Data cukup? → return FactorReport
              Belum cukup → loop lagi
              Loop 3 → force return dengan data yang ada
```

**LLM call per loop:** 1 (THINK step).
**Max LLM calls per subagent:** 3.
**Timeout per subagent:** 60s.
**Tool failure:** return error metadata, lanjut dengan tool lain.

### 3.2 Main Agent: Plan-Execute-Reflect

```
LOOP (max 5):
  1. PLAN:    LLM terima asset + category → buat rencana
              subagent mana, instruksi spesifik
  2. EXECUTE: Deploy subagents in parallel (Promise.all)
  3. AGGREGATE: LLM merge + deterministic scoring
  4. EVALUATE: Structured check:
              - >=3 factor confidence >= 60? → ACCEPT
              - 1-2 factor low confidence → RE-DEPLOY targeted
              - 3+ factor fail → PARTIAL (return with errors)
              - all fail → FAILED flag
  5. RE-PLAN: Jika RE-DEPLOY, buat instruksi baru untuk
              subagent yang kurang
```

---

## 4. Tool System

### 4.1 Tool Interface

```ts
// lib/agent/tools/types.ts
interface ToolDefinition<TParams = z.ZodTypeAny> {
  name: string
  description: string       // LLM-readable
  parameters: TParams       // Zod schema, validated before execute
  execute: (params: z.infer<TParams>) => Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  metadata: {
    source: string          // e.g. "technicalindicators", "hyperliquid", "coingecko"
    latencyMs: number
  }
}

type ToolRegistry = Record<string, ToolDefinition>
```

### 4.2 Technical Tools (via `technicalindicators` npm + HL candles)

**Source:** [`technicalindicators`](https://www.npmjs.com/package/technicalindicators) —
v3.1.0, pure JS, zero runtime deps. Covers RSI, MACD, EMA, SMA, WMA, Bollinger Bands, ATR,
Stochastic, OBV, Ichimoku Cloud, KST, ROC, AO, Keltner Channels, PSAR, ADX, and more.
Already indirectly used in `lib/agent/planning/risk-engine.ts` (computeATR).

**Design: 3-timeframe pre-fetch (Approach C)**
TechnicalSubAgent does NOT fetch candles per-indicator call. Instead:
1. At subagent start, fetch 3 timeframes ONCE via existing HL `fetchCandles()`:
   - `candles1h` (200 bars) — primary
   - `candles15m` (200 bars) — granular
   - `candles1d` (100 bars) — macro
2. Each ToolDefinition receives the pre-fetched `CandleMap` and reads from memory.
3. LLM picks indicator + timeframe via THINK step → tool computes from in-memory data → OBSERVE.

**Tools (~12, wrapping `technicalindicators` + manual calcs):**

| Tool | Description | Parameters | Implemented via |
|------|-------------|------------|----------------|
| `get_rsi` | Relative Strength Index (0-100) | period=14, timeframe? | `RSI.calculate(closes, period)` |
| `get_macd` | MACD (line, signal, histogram) | fast=12, slow=26, signal=9, timeframe? | `MACD.calculate(closes, fast, slow, signal)` |
| `get_ema` | Exponential Moving Average | period, timeframe? | `EMA.calculate(closes, period)` |
| `get_sma` | Simple Moving Average | period, timeframe? | `SMA.calculate(closes, period)` |
| `get_bb` | Bollinger Bands | period=20, stddev=2, timeframe? | `BollingerBands.calculate(closes, period, stddev)` |
| `get_atr` | Average True Range | period=14, timeframe? | `ATR.calculate(highs, lows, closes, period)` |
| `get_stoch` | Stochastic Oscillator | k=14, d=3, timeframe? | `Stochastic.calculate(highs, lows, closes, k, d)` |
| `get_obv` | On-Balance Volume | timeframe? | `OBV.calculate(closes, volumes)` |
| `get_ichimoku` | Ichimoku Cloud | tenkan=9, kijun=26, senkou=52, timeframe? | `IchimokuCloud.calculate(highs, lows, tenkan, kijun, senkou)` |
| `get_volume` | Volume trend analysis | timeframe? | Manual: avg volume, volume ratio, trend direction |
| `get_support_resistance` | Key S/R levels via pivots | timeframe? | Manual: swing high/low detection from high/low arrays |
| `get_fibonacci` | Fibonacci retracement levels | timeframe? | Manual: swing high/low → 0.236/0.382/0.5/0.618/0.786 levels |
| `get_divergence` | RSI/MACD price divergence | indicator ("rsi"\|"macd"), timeframe? | Manual: slope comparison price vs indicator |

**Omitted for MVP (YAGNI):**
- BOS/CHoCH market structure — no clean lib, manual impl = scope creep
- Candlestick pattern recognition — `technicalindicators` has partial functions but limited coverage
- KST, ROC, AO, Keltner, ADX — available via `technicalindicators` but LLM unlikely to use in 3 loops

**Integration pattern:**
```ts
// lib/agent/tools/technical/indicators.ts
import { RSI, MACD, EMA, SMA, BollingerBands, ATR, Stochastic, OBV, IchimokuCloud } from "technicalindicators"

// Pre-fetch at subagent start (3 bounded HL calls):
// CandleMap = { "1h": CandleData[], "15m": CandleData[], "1d": CandleData[] }
// Each tool reads candles from the timeframe-appropriate array.

// Example ToolDefinition:
const rsiTool: ToolDefinition = {
  name: "get_rsi",
  description: "Relative Strength Index (0-100). Period default 14. Use for overbought (>70) / oversold (<30) / divergence.",
  parameters: z.object({ period: z.number().default(14), timeframe: z.enum(["1h","15m","1d"]).default("1h") }),
  execute: async (params) => {
    const candles = getTimeframeCandles(params.timeframe)
    const values = RSI.calculate(candles.map(c => c.close), params.period)
    return { success: true, data: values, metadata: { source: "technicalindicators", latencyMs: 0 } }
  }
}
```

**No Python process, no Docker Compose for technical tools.** ArangoDB tetap local install.

### 4.3 Onchain Tools (Multi-source)

| Tool | Source | Description | Parameters |
|------|--------|-------------|------------|
| `get_funding_rate` | Hyperliquid API | Current/predicted funding | asset |
| `get_open_interest` | Hyperliquid API | Open interest + cap | asset |
| `get_orderbook_depth` | Hyperliquid API | Bid/ask depth | asset, depth? |
| `get_mark_price` | Hyperliquid API | Mark price vs oracle | asset |
| `get_tvl` | DeFiLlama API | Total Value Locked | protocol or chain |
| `get_protocol_volume` | DeFiLlama API | 24h volume | protocol |
| `get_protocol_fees` | DeFiLlama API | Fees/revenue | protocol |
| `get_token_supply` | CoinGecko API | Circ/max/total supply | coingeckoId |
| `get_market_cap` | CoinGecko API | Market cap + rank | coingeckoId |
| `get_24h_volume` | CoinGecko API | 24h trading volume | coingeckoId |
| `get_whale_txns` | Explorer (custom) | Large transactions | asset, minValue? |
| `get_exchange_flow` | Explorer (custom) | Inflow/outflow tracker | asset |

**Smart money / exchange flow (MVP):** Nansen/Glassnode berbayar. Untuk MVP,
bangun tracker sederhana berbasis blockchain explorer public endpoints —
track large transfers (>$100k) dari/ke known exchange addresses.

### 4.4 Sentiment Tools (via cryptocurrency.cv)

**Source:** [cryptocurrency.cv](https://github.com/nirholas/free-crypto-news) — 353 endpoints,
30 categories, 130+ news sources. **Free tier: 100 req / 15 min, NO API key needed.**
AI endpoints powered by Groq (free). License: README says MIT (repo metadata "Other").
Premium endpoints use x402 micropayments (USDC on Arbitrum). SDKs in 13 langs incl TypeScript.

| Tool | Endpoint | Description |
|------|----------|-------------|
| `get_ai_sentiment` | `/api/sentiment` | AI-powered market sentiment analysis |
| `get_narratives` | `/api/narratives` | Emerging narratives, thematic trends |
| `get_trending_topics` | `/api/trending` | Trending coins/topics |
| `get_twitter_sentiment` | `/api/social/x/sentiment` | Twitter/X sentiment per coin |
| `get_ai_research` | `/api/ai/research` | Deep research on specific topic |
| `get_news` | `/api/news` | Latest crypto news aggregated |
| `get_fear_greed` | Existing AltMe | Fear & Greed Index (already implemented) |

**Topic relevance scoring:** Gunakan narasi dari `/api/narratives` + trending data
dari `/api/trending` → LLM evaluate apakah naratif asset masih relevant dan
trending atau sudah outdated.

### 4.5 Fundamental Tools

| Tool | Source | Description |
|------|--------|-------------|
| `get_coin_metadata` | CoinGecko API | Description, links, categories |
| `get_tokenomics` | CoinGecko + PublicDrop | Supply schedule, unlock events, inflation |
| `get_ath` | CoinGecko API | ATH price + drawdown % |
| `get_developer_activity` | CoinGecko API | GitHub stats |

### 4.6 Tool Access Matrix

| Agent | Technical | Onchain | Sentiment | Fundamental |
|-------|:---------:|:-------:|:---------:|:-----------:|
| TechnicalSubAgent | ✅ | | | |
| OnchainSubAgent | | ✅ | | |
| SentimentSubAgent | | | ✅ | |
| FundamentalSubAgent | | | | ✅ |
| DDAgentMain | ✅ | ✅ | ✅ | ✅ |

Main agent has cross-factor access untuk verifikasi (e.g. cek apakah data teknikal
selaras dengan onchain).

---

## 5. Type Definitions

### 5.1 New Types (extends `lib/agent/types.ts`)

```ts
// FactorReport — output dari setiap subagent
interface FactorReport {
  factor: Factor                    // "technical" | "onchain" | "sentiment" | "fundamental"
  score: number                     // 0-100 (nullable jika factor inactive)
  confidence: number                // 0-100
  signals: SignalEntry[]
  dataSources: string[]             // list tool/source yang dipakai
  reasoning: string                 // LLM reasoning lengkap
  iterations: number                // jumlah ReAct loop yang digunakan
  conclusion: string                // ringkasan 1-2 kalimat
  errors: string[]                  // non-fatal errors
}

interface SignalEntry {
  name: string                      // e.g. "RSI_Oversold", "Funding_Positive"
  strength: number                  // 0-100
  direction: "bullish" | "bearish" | "neutral"
}

// Updated DDReport (extend existing)
// Existing fields: asset, category, timestamp, sections, aggregated_thesis,
//                   confidence_score, risk_flags, errors
// New fields:
interface DDReport {
  // ...existing fields...
  factorReports: FactorReport[]          // NEW: full per-factor reports
  overallScore: number                   // NEW: 0-100 weighted composite
  overallConfidence: number              // NEW: 0-100 (min dari confidence factors)
  crossValidation: CrossValidation       // NEW: cross-factor analysis
  risks: RiskEntry[]                     // NEW: structured risks
  catalysts: CatalystEntry[]             // NEW: positive catalysts
  summary: string                        // NEW: overall summary 3-5 kalimat
  iterations: number                     // NEW: main agent loop count
  status: "complete" | "partial" | "failed"  // NEW
  processingTimeMs: number               // total
}

interface CrossValidation {
  pairs: ValidationPair[]
  overallAlignment: number               // 0-100
  contradictions: string[]
}

interface ValidationPair {
  factorA: Factor
  factorB: Factor
  alignment: number                      // 0-100
  note: string
}

interface RiskEntry {
  factor: Factor
  description: string
  severity: "low" | "medium" | "high"
}

interface CatalystEntry {
  factor: Factor
  description: string
  impact: "low" | "medium" | "high"
}

// Agent run state (runtime, in-memory)
interface AgentRunState {
  runId: string
  asset: string
  category: CategoryConfig
  status: "planning" | "executing" | "aggregating" | "evaluating" | "complete" | "failed"
  plan?: AgentPlan
  factorReports: Map<Factor, FactorReport | null>
  iteration: number
  errors: string[]
  startedAt: number
}

interface AgentPlan {
  subagents: SubagentPlan[]
  reDeployHistory: ReDeployEntry[]
}

interface SubagentPlan {
  factor: Factor
  instruction: string            // instruksi spesifik dari main agent
  priority: number               // 1-4, 1 highest
}

interface ReDeployEntry {
  factor: Factor
  previousConfidence: number
  newInstruction: string
  iteration: number
}
```

---

## 6. ReAct Loop Implementation

### 6.1 SubAgent Core

```ts
// lib/agent/due-diligence/subagent.ts
async function runSubagent(params: {
  factor: Factor
  tools: ToolRegistry
  instruction: string
  asset: string
  maxLoops: number              // default 3
  timeoutMs: number             // default 60000
}): Promise<FactorReport>

// Internal loop:
for (let i = 0; i < maxLoops; i++) {
  // 1. THINK: LLM call dengan tool descriptions + context
  const thought = await llmThink({
    factor, tools, instruction, asset,
    history: previousResults,
    remainingLoops: maxLoops - i
  })

  if (thought.action === "return") {
    // Agent decides data is sufficient
    return buildFactorReport(thought, factor, history)
  }

  // 2. ACT: Execute the chosen tool
  const tool = tools[thought.toolName]
  const result = await withRetry(() => tool.execute(thought.params), { maxRetries: 1 })

  // 3. OBSERVE: Record result
  history.push({ toolName: thought.toolName, result })

  // 4. REFLECT: Loop continues automatically
}

// Force return on last loop
return buildFactorReport(forceReturn(factor, history))
```

### 6.2 Main Agent Core

```ts
// lib/agent/due-diligence/agent.ts
async function runDDAgent(params: {
  asset: string
  category: CategoryConfig
  maxLoops: number              // default 5
}): Promise<DDReport>

// Internal loop:
let state = initializeState(asset, category)

for (let i = 0; i < maxLoops; i++) {
  state.iteration = i

  // 1. PLAN
  if (i === 0) {
    state.plan = await llmPlan({ asset, category })  // initial plan
  } else {
    state.plan = await llmRePlan({ state, evaluation })  // re-plan
  }

  // 2. EXECUTE (parallel)
  const results = await Promise.all(
    state.plan.subagents.map(s =>
      runSubagent({
        factor: s.factor,
        tools: getToolRegistry(s.factor),
        instruction: s.instruction,
        asset
      })
    )
  )

  // 3. AGGREGATE
  const aggregated = await llmAggregate({ factorReports: results, asset, category })
  const deterministic = computeDeterministicScore(results)

  // 4. EVALUATE
  const evaluation = evaluateResults(results, aggregated)

  if (evaluation.decision === "ACCEPT") {
    return buildFinalReport(results, aggregated, deterministic, state)
  }
  if (evaluation.decision === "PARTIAL" || evaluation.decision === "FAILED") {
    return buildFinalReport(results, aggregated, deterministic, state)
  }
  // RE-DEPLOY: loop continues with targeted re-deploy
  state.plan = buildReDeployPlan(evaluation.lowConfidenceFactors, i)
}
```

---

## 7. LLM Integration

### 7.1 Model & Configuration

**Verified 2026-07-24.** Base URL `https://api.deepseek.com`, endpoint `/chat/completions`
(NOT `/responses`). Thinking param: `extra_body={"thinking":{"type":"enabled"}}` +
`reasoning_effort="high"|"max"`. Non-thinking: `extra_body={"thinking":{"type":"disabled"}}`.
JSON mode: `response_format={"type":"json_object"}` — prompt MUST include word "json" + schema example.

| Aspect | SubAgent (ReAct) | Main Agent |
|--------|------------------|------------|
| Model | `deepseek-v4-flash` (284B/13B active) | `deepseek-v4-pro` (1.6T/49B active) |
| Mode | Non-thinking (fast) | Thinking enabled |
| Temperature | 0.3 | **ignored** (thinking mode silently ignores temp/top_p/penalties) |
| Response format | `json_object` | `json_object` |
| Max tokens | 4096 | 8192 |
| Context / max output | 1M / 384K | 1M / 384K |

SubAgent pakai flash karena perlu cepat — banyak tool calls. Main agent pakai pro
karena reasoning lebih kompleks (planning + aggregation + evaluation).

**⚠ temps:** Main agent temp 0.3 has NO effect in thinking mode — rely on `reasoning_effort`.
SubAgent temp 0.3 is valid (non-thinking).

**⚠ legacy models:** `deepseek-chat` / `deepseek-reasoner` RETIRE 2026-07-24 15:59 UTC.
Project MUST migrate to `deepseek-v4-flash`/`deepseek-v4-pro` if any code still uses legacy IDs.

**Pricing (Apr 2026 promo, verify live):** Flash $0.14 in / $0.28 out per M tokens.
Pro 75% promo thru 2026-05-31: $0.435 in / $0.87 out. Per DD run (max 17 calls) ≈ pennies.

### 7.2 Tool Description Format (LLM-readable)

Tools dideskripsikan ke LLM dalam format (contoh technical tools):
```
Available tools:
- get_rsi(period?: number, timeframe?: "1h"|"15m"|"1d"):
  Relative Strength Index 0-100. Period default 14. Returns array of RSI values.
  Use for overbought (>70) / oversold (<30) / divergence detection.
  timeframe default "1h". Use "15m" for granular or "1d" for macro.

- get_macd(fast?: number, slow?: number, signal?: number, timeframe?: "1h"|"15m"|"1d"):
  MACD line, signal line, histogram. Fast default 12, slow 26, signal 9.
  Use for trend direction, momentum, and signal cross detection.

- get_ema(period: number, timeframe?: "1h"|"15m"|"1d"):
  Exponential Moving Average. Use for trend following. Common periods: 20, 50, 200.

- get_bb(period?: number, stddev?: number, timeframe?: "1h"|"15m"|"1d"):
  Bollinger Bands (upper, middle, lower). Period default 20, stddev 2.
  Use for volatility, squeeze/expansion, overextended price.

- get_atr(period?: number, timeframe?: "1h"|"15m"|"1d"):
  Average True Range. Period default 14. Use for volatility measurement and position sizing.

- get_stoch(k?: number, d?: number, timeframe?: "1h"|"15m"|"1d"):
  Stochastic Oscillator (%K, %D). K default 14, D default 3. Overbought >80, oversold <20.

- get_ichimoku(tenkan?: number, kijun?: number, senkou?: number, timeframe?: "1h"|"15m"|"1d"):
  Ichimoku Cloud (tenkan, kijun, senkouA, senkouB, chikou). Use for trend + support/resistance.

- get_volume(timeframe?: "1h"|"15m"|"1d"):
  Volume analysis — average volume, volume ratio, trend. Use to confirm price moves.

- get_support_resistance(timeframe?: "1h"|"15m"|"1d"):
  Key support/resistance levels via swing high/low pivots. Use for entry/exit levels.

- get_fibonacci(timeframe?: "1h"|"15m"|"1d"):
  Fibonacci retracement levels from latest swing high/low.
  Levels: 0.236, 0.382, 0.5, 0.618, 0.786. Use for pullback targets.

- get_divergence(indicator: "rsi"|"macd", timeframe?: "1h"|"15m"|"1d"):
  Detect hidden/regular divergence between price and RSI/MACD.
  Use to spot reversal signals (regular) or trend continuation (hidden).
```

### 7.3 Thinking Output Schema (SubAgent)

```ts
const SubAgentThoughtSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tool_call"),
    toolName: z.string(),
    params: z.record(z.unknown()),
    reasoning: z.string()     // why this tool
  }),
  z.object({
    action: z.literal("return"),
    score: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
    signals: z.array(SignalEntrySchema),
    reasoning: z.string(),
    conclusion: z.string(),
  }),
])
```

---

## 8. Error Handling & Resilience

### 8.1 Tool Failure
```
- Retry 1x with exponential backoff (500ms)
- Return { success: false, error: "..." }
- Subagent: continue with remaining tools, note error in FactorReport.errors[]
```

### 8.2 LLM Failure
```
- Retry 1x
- SubAgent fallback: return FactorReport dengan raw tool results, confidence 0
- Main fallback: return DDReport dengan status "partial", errors[]
```

### 8.3 SubAgent Timeout
```
- 60s max per subagent
- Force stop at loop 3 (atau loop saat ini jika belum selesai)
- Return partial FactorReport
```

### 8.4 SubAgent Total Failure
```
- Jika 3+ subagent gagal total → status "failed"
- Jika 1-2 gagal → status "partial", tetap return data yang ada
```

### 8.5 Main Agent Evaluation Decision Matrix

| Condition | Decision | Status |
|-----------|----------|--------|
| >=3 factors confidence >= 60, no contradictions | ACCEPT | complete |
| 1-2 factors confidence < 60 | RE-DEPLOY (max 2x per factor) | — |
| >=3 factors fail | — | failed |
| Re-deployed still low but >=2 factors OK | ACCEPT | partial |
| Contradictions found (e.g. technical bullish, onchain bearish) | RE-DEPLOY cross-verify | — |

---

## 9. Memory & State

### 9.1 Runtime State
- `AgentRunState` — in-memory JavaScript object, per-run
- Tidak dipersist ke DB (volatile)

### 9.2 DDReport Persistence
- Collection `dd_reports` di ArangoDB (baru)
- Schema: full DDReport + `runId`, `userId`, `walletAddress`
- Write after DD complete (non-blocking, fire-and-forget)

### 9.3 Graph Memory (existing, extend)
- Node `DecisionNode` sudah ada → edge `decision_analyzed` ke `AssetNode`
- Tambah edge `decision_has_factorreport` → menuju `SignalNode` per factor
- Untuk cross-analysis: AQL query traverse `decision → signal → outcome` patterns

### 9.4 Tool Cache
- Skip MVP. Future: Redis atau in-memory TTL cache untuk tool results
  yang mahal/slow (e.g. explorer queries)

---

## 10. File Structure

```
lib/agent/
  types.ts                          # EXTEND: DDReport, FactorReport, etc.
  tools/
    types.ts                        # NEW: ToolDefinition, ToolRegistry, ToolResult
    registry.ts                     # NEW: buildToolRegistry(), getToolRegistry(factor)
    technical/
      candles.ts                    # NEW: fetch + cache CandleMap (3 timeframes at subagent start)
      indicators.ts                 # NEW: ~12 ToolDefinitions wrapping technicalindicators + manual
      index.ts                      # NEW: buildTechnicalRegistry(candleMap): ToolRegistry
    onchain/
      hyperliquid.ts                # REFACTOR: wrap existing HL calls as tools
      defillama.ts                  # NEW: DeFiLlama API client + tools
      coingecko.ts                  # REFACTOR: wrap existing CG calls as tools
      explorer.ts                   # NEW: blockchain explorer tools
    sentiment/
      cryptocurrencycv.ts           # NEW: cryptocurrency.cv API client + tools
      altme.ts                      # REFACTOR: wrap existing AltMe as tool
    fundamental/
      coingecko-metadata.ts         # REFACTOR: wrap as tools
      publicdrop.ts                 # REFACTOR: wrap as tools
  due-diligence/
    agent.ts                        # NEW: DDAgentMain (Plan-Execute-Reflect)
    subagent.ts                     # NEW: ReAct subagent loop
    llm.ts                          # REFACTOR: add think(), plan(), aggregate(), evaluate()
    prompts.ts                      # REFACTOR: add system prompts for ReAct + aggregation
    evaluate.ts                     # NEW: structured evaluation logic
    pipeline.ts                     # REFACTOR: thin wrapper calling agent.ts
    types.ts                        # NEW: AgentPlan, ReDeployEntry, etc.

app/api/agent/dd/
  route.ts                          # REFACTOR: call agent instead of pipeline
```

---

## 11. Testing Strategy

### 11.1 Unit Tests
- Setiap tool: validasi Zod schema, mock HTTP response, test parsing
- `evaluateResults()`: semua kasus decision matrix
- `buildFinalReport()`: semua field terisi dengan benar

### 11.2 Integration — SubAgent
- Test ReAct loop dengan mock tools: assert ≤3 loops, assert return value
- Test tool failure: subagent lanjut dengan error metadata
- Test timeout: force stop after 60s, return partial

### 11.3 Integration — Main Agent
- Happy path: semua subagent return normal, DDReport complete
- Partial: 1-2 subagent gagal, status "partial"
- Re-deploy: confidence rendah → re-deploy → confidence naik → ACCEPT
- All fail: semua subagent gagal, status "failed"
- Cross-validation: contradiction terdeteksi → flag di crossValidation

### 11.4 E2E
- Satu analisis BTC penuh via dashboard → DB → history query
- Verifikasi DDReport tersimpan di ArangoDB dengan benar

---

## 12. Migration Plan

### Phase 1: Tool Layer (no behavior change)
1. Buat `lib/agent/tools/` — interface + registries
2. Wrap semua existing data fetcher sebagai tools (HL, CG, AltMe, etc.)
3. Install `technicalindicators` npm, buat `lib/agent/tools/technical/` (candles.ts, indicators.ts, index.ts)
4. Tambah cryptocurrency.cv integration
5. Tambah DeFiLlama integration
6. Unit test semua tools

### Phase 2: SubAgent ReAct
1. Buat `subagent.ts` — generic ReAct loop
2. LLM prompt engineering untuk THINK step
3. Integration test per factor

### Phase 3: Main Agent
1. Buat `agent.ts` — Plan-Execute-Reflect
2. LLM prompt engineering untuk PLAN + AGGREGATE + EVALUATE
3. Integration test semua scenario

### Phase 4: Cutover
1. Refactor `pipeline.ts` → thin wrapper
2. Update `app/api/agent/dd/route.ts`
3. E2E test
4. Remove old pipeline code

---

## 13. External Resources

### Tools / MCP Servers
- [`technicalindicators`](https://www.npmjs.com/package/technicalindicators) — v3.1.0, pure JS, zero runtime deps, RSI/MACD/EMA/SMA/BB/ATR/Stoch/OBV/Ichimoku/KST/ROC/AO/Keltner/PSAR/ADX
- [cryptocurrency.cv](https://github.com/nirholas/free-crypto-news) — 353 endpoints, free tier 100 req/15min (no key), AI via Groq, premium via x402 USDC
- [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs) — already integrated
- [DeFiLlama API](https://defillama.com/docs/api) — free, no key, TVL/volume/fees
- [CoinGecko API](https://docs.coingecko.com/reference/introduction) — free tier, rate-limited (~30 req/min)
- [DeepSeek V4](https://api.deepseek.com) — `deepseek-v4-flash` / `deepseek-v4-pro`, OpenAI-compat, thinking via `extra_body.thinking.type`

### Reference Implementations
- [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) — 27k stars, Python/FastAPI, agent swarm, MCP tool-based, 461 alpha factors
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — workflow vs agent distinction
- [Lilian Weng: LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/) — Agent = LLM + Tools + Memory + Planning + Loop

### Current Codebase References
- `lib/agent/types.ts` — existing DDReport, TradePlan, Factor types
- `lib/agent/due-diligence/pipeline.ts` — current DD pipeline
- `lib/agent/due-diligence/llm.ts` — existing LLM integration
- `lib/agent/due-diligence/prompts.ts` — existing prompts
- `lib/agent/planning/pipeline.ts` — planning agent (hybrid LLM+code pattern)
- ~~`lib/agent/execution/pipeline.ts` — execution agent~~ (tidak ada di codebase — scope sekarang cuma paper trading; live execution = future work, lihat docs/odin-spec.md §4.4)
- `lib/data/` — current data providers (to be refactored as tools)
- `lib/db/` — ArangoDB graph memory
- `docs/odin-spec.md` — master architecture spec

---

## 14. Resolved Questions (Decision Log)

> All open questions resolved during interview-me session. Decisions below are
> binding for implementation.

1. **Technical Agent tool layer:** → **`technicalindicators` npm + HL candles (Approach C).**
   TIDAK pakai Tickscope MCP. TechnicalSubAgent pakai `technicalindicators` npm (pure JS,
   no runtime deps) + 3-timeframe pre-fetch dari existing HL `fetchCandles()` — lihat §4.2.
   Tidak perlu Docker Compose — hanya ArangoDB (local). Tidak ada Python process.
   Keuntungan: zero new infra, reuse existing candle fetcher pattern, pure JS.

2. **CoinGecko rate limit:** → **Skip rate limiter untuk MVP.** Free tier ~30 req/min
   tidak di-handle di kode. Document limit di `lib/agent/tools/onchain/coingecko.ts`
   header comment + `README`. Jika production nanti hit limit, baru implementasi
   in-memory TTL cache. Catatan: cryptocurrency.cv free tier 100 req/15min juga
   tidak di-rate-limit eksplisit — ReAct loop natural ceiling (max 3 calls per
   subagent) cukup.

3. **LLM cost:** → **No budget cap.≈ pennies per run.** Estimasi: 4 subagent × max 3
   flash calls + main agent × max 5 pro calls (thinking) = max 17 calls.
   Flash $0.14/$0.28 per M tokens, Pro promo $0.435/$0.87 per M tokens.
   Per run < $0.05. Tidak perlu budget cap. Lihat §7.1 untuk pricing detail.

4. **Subagent parallelization:** → **4 parallel LLM calls fine, no queue.** DeepSeek
   tidak publish per-min rate limit, hold requests open rather than 429.
   `Promise.all` atas 4 subagent aman. No queue/throttle needed.

5. **Tool discovery:** → **Self-correct via ReAct loop only, no pre-check layer.**
   Jika LLM salah pilih tool (e.g. `compute_indicators` padahal butuh `get_ohlcv`
   dulu), OBSERVE step lihat `success:false` atau empty → THINK iterasi berikutnya
   LLM lihat error → pick different tool/fix params. Max 3 loops = natural ceiling.
   Jika burn all 3 on wrong tools → SubAgent return `confidence: 0` → Main Agent
   EVALUATE RE-DEPLOY targeted atau PARTIAL. No tool pre-check/validation layer.

6. **Fundamental factor skip untuk meme:** → **LLM-driven, no hardcoded filter.**
   Tidak ada `skipFactors` array di kode. Category context (meme/forex/stock/other)
   masuk ke PLAN prompt — LLM sendiri yang decide apakah deploy FundamentalSubAgent.
   Main agent trusts LLM planning reasoning. Lihat §3.2 + §6.2 — `llmPlan()` terima
   `category` field, prompt instructs "skip fundamental subagent jika category=meme
   karena meme tidak punya fundamental data yang relevan".

7. **Database migration:** → **dd_reports collection + graph edges in ONE migration.**
   Update `setupArangoGraph()` di `lib/db/setup.ts`:
   - Create document collection `dd_reports` (schema: full DDReport + runId, userId,
     walletAddress)
   - Create edge `decision_has_factorreport` dari `DecisionNode` → `SignalNode` per
     factor (untuk cross-analysis AQL traverse)
   Both done atomically di setup script. Lihat §9.2 + §9.3.

8. **Existing DD pipeline backward compatibility:** → **Breaking change OK, modify
   all consumers.** Tidak ada backward-compat shim. Update DDReport schema di
   `lib/agent/types.ts` + migrate semua consumers:
   - `app/api/agent/dd/route.ts` — return new DDReport
   - ~~`app/api/agent/execution/route.ts` — parse new DDReport~~ (route tidak ada; doc historis sebelum execution di-drop dari scope)
   - `app/api/agent/planning/route.ts` — parse new DDReport
   - ~~`app/api/agent/trade/approve/route.ts` — parse new DDReport~~ (route tidak ada; doc historis)
   - `components/dashboard/dd-section.tsx` — reads `aggregated_thesis` +
     `confidence_score` (ganti ke `summary` + `overallConfidence` fields baru)
   All consumers already use `DDReportSchema.safeParse/parse` which tolerate
   optional fields — additive fields OK. Breaking: rename `aggregated_thesis` →
   `summary`, `confidence_score` → `overallConfidence` di dashboard.

---

## 15. Implementation Notes (post-interview)

- **`technicalindicators` npm:** Install `npm install technicalindicators`, ~12 ToolDefinitions
  di `lib/agent/tools/technical/indicators.ts`. Zero infra — pure JS, semua compute in-process.
  Candle pre-fetch reuse existing `lib/data/hyperliquid.ts` `fetchCandles()` pattern.
- **DeepSeek thinking mode:** `temperature` parameter DIABAIKAN silently di thinking
  mode. Main agent (`deepseek-v4-pro` thinking) — jangan set temp, atau set tapi
  doc bahwa ignored. SubAgent (`deepseek-v4-flash` non-thinking) — temp 0.3 valid.
- **Legacy model retirement:** `deepseek-chat` / `deepseek-reasoner` pensiun
  2026-07-24. Project MUST use `deepseek-v4-flash` / `deepseek-v4-pro`.
- **Self-host cryptocurrency.cv:** Jika 100 req/15min tidak cukup, self-host
  (Vercel/Docker) untuk unlimited. MVP pakai free tier dulu.
- **ReAct natural ceiling:** Max 3 loops per subagent = max 3 tool calls.
  cryptocurrency.cv 100 req/15min / 3 calls per subagent = ~33 subagent runs
  per 15min window. Aman untuk single-user demo.
