# Spec: Planning & Decision Agent Pipeline

> **Status:** Approved
> **Ref:** `docs/odin-spec.md` §4.2, §6, §7, §8, §9, §13, §14
> **Input from:** `docs/dd-pipeline-spec.md` (DDReport shape, patterns to mirror)

---

## 1. Objective

Build the Planning & Decision Agent — the second agent in Odin's agent pipeline (DD → Planning → paper trading). Planning Agent takes a `DDReport` (produced by DD Agent) plus user context (userId, walletAddress), queries Graph Memory (ArangoDB) for historical patterns, runs hybrid LLM+code reasoning to produce a trade plan (side, size, SL/TP, leverage, confidence), applies autonomy gating, and returns a `TradePlan` to the caller. Stops at the gate decision — does NOT call Execution Agent, does NOT persist pending plans.

**Success criteria:**
- Given a valid `DDReport` + `userId` + `walletAddress`, produce a valid `TradePlan` JSON within 60 seconds
- Hybrid methodology: 4 DeepSeek thinking-mode calls (3 perspective runs + 1 aggregator) + deterministic risk engine (fixed-fractional position sizing + ATR-based SL/TP)
- Entry price = deterministic current mark price (LLM never touches entry price)
- Leverage = LLM suggests, risk engine caps to max allowed
- Confidence score = LLM-output (0-100) with per-component breakdown (factor_alignment, historical_match, signal_strength)
- Autonomy gate: `IF confidence_score >= threshold_confidence AND position_size_usdc <= threshold_max_position THEN auto ELSE approve`
- Risk thresholds: query `risk_thresholds` ArangoDB collection per userId; env defaults as fallback
- Graph Memory: real AQL queries against ArangoDB for historical pattern lookup
- Pipeline triggered on-demand via `POST /api/agent/planning`

---

## 2. Data Flow

```
Trigger (API route)
      │
      ▼
  fetchMarkPrice(asset)         ──► current mark price (deterministic entry)
  fetchCandles(asset, 1h)       ──► candle array → ATR computation
  fetchUserEquity(walletAddr)   ──► equity (USDC) from HL clearing state
  fetchRiskThresholds(userId)   ──► { confidence, maxPosition, maxLeverage } | null
      │
      ▼   (parallel fetch via Promise.all)
  queryGraphPatterns(asset, category, signals)
      └──► AQL → [{ pattern, outcome, frequency }]  (historical pattern matches)
      │
      ▼
  3× Perspective LLM runs (thinking mode, prompt-framed diversity)
      ├──► runPerspective("conservative", ddReport, graphPatterns, markPrice) ──► PerspectiveResult
      ├──► runPerspective("balance",      ddReport, graphPatterns, markPrice) ──► PerspectiveResult
      ├──► runPerspective("aggressive",   ddReport, graphPatterns, markPrice) ──► PerspectiveResult
      │
      ▼   (sequential after all 3 perspectives complete)
  Aggregator LLM call (thinking mode)
      └──► synthesizePerspectives(perspectives) ──► AggregatedReasoning
              { side, thesis, reasoning, confidence_breakdown, leverage_suggested, risk_flags }
      │
      ▼   (deterministic code, NOT LLM)
  Risk Engine
      ├──► computeATR(candles)                   ──► atr value
      ├──► computeSL_TP(entry, atr, side)        ──► { stop_loss, take_profit }
      ├──► computePositionSize(equity, riskPct, entry, sl)  ──► position_size_usdc + contracts
      └──>> capLeverage(llm_suggested, max_allowed)         ──► final leverage
      │
      ▼
  Autonomy Gate (code)
      └──► IF confidence >= threshold_confidence AND position_size_usdc <= threshold_max_position
            THEN autonomy_decision = "auto"
            ELSE autonomy_decision = "approve"
      │
      ▼
  Assemble TradePlan → validate against Zod schema → return
```

Key constraints:
- 3 perspective runs execute in parallel (`Promise.all`); aggregator runs after all 3 complete
- Deterministic numbers (entry, SL, TP, position size, leverage cap) NEVER come from LLM — only LLM-output is `leverage_suggested` (capped by code) and `confidence_score` (with breakdown)
- Graph Memory queries run in parallel with mark price / candles / equity / thresholds fetches
- Max total time target: 60s (data fetch ≤10s, 4× thinking-mode LLM calls ≤45s, risk engine ≤1s)

---

## 3. Data Sources

### 3.1 Primary: Hyperliquid Info API (via `@nktkas/hyperliquid` SDK)

| Data Point | SDK Method | Used For |
|---|---|---|
| Current mark price | `infoClient.allMids()` or `infoClient.l2Book({ coin, resolution })` | Entry price (deterministic) |
| OHLCV candles (1h) | `infoClient.candleSnapshot({ coin, interval: "1h", startTime, endTime })` | ATR computation |
| User clearing state | `infoClient.userClearingState({ user: walletAddress })` → `crossMarginSummary.value` | Equity for position sizing |

**Existing helper:** `fetchCandles` already implemented in `lib/data/hyperliquid.ts` — reused by Planning Agent.

### 3.2 Graph Memory: ArangoDB (via `arangojs`)

| Query | AQL Pattern | Used For |
|---|---|---|
| Historical patterns | `FOR d IN decisions FILTER d.category == @category FOR s IN 1..1 OUTBOUND d TRIGGERED_BY FILTER s.name IN @signals FOR o IN 1..1 OUTBOUND d RESULTED_IN RETURN { pattern: s.name, outcome: o.result, pnl: o.pnl }` | `confidence_breakdown.historical_match` + `graph_patterns_used` |
| Asset node lookup | `FOR a IN assets FILTER a.symbol == @asset RETURN a` | Confirm asset exists in graph |
| Category outcomes summary | `FOR d IN decisions FILTER d.category == @category COLLECT outcome = d.outcome WITH COUNT INTO c RETURN { outcome, count }` | Aggregate pattern frequency |

**Empty graph handling:** On first run, graph has no historical data. Query returns empty array. Pipeline continues with `graph_patterns_used: []` and `confidence_breakdown.historical_match = 50` (neutral, no prior data). This is acceptable for MVP — graph populates over time as Execution Agent records outcomes.

### 3.3 Risk Thresholds: ArangoDB Document Collection

Collection `risk_thresholds` (document collection, not graph):

```json
{
  "userId": "0xabc...",
  "confidence_threshold": 70,
  "max_position_usdc": 100,
  "max_leverage": 10,
  "risk_per_trade_percent": 1
}
```

If document for `userId` is null/missing, fall back to env defaults (see §10).

### 3.4 Rate Limit Strategy

| API | Limit | Mitigation |
|---|---|---|
| Hyperliquid Info | ~1200 req/min | Sufficient for single Planning run |
| ArangoDB (local) | None (localhost) | No mitigation needed |
| DeepSeek thinking mode | Slower + higher token cost | 4 calls per plan, acceptable for on-demand trigger |

---

## 4. LLM Integration

### 4.1 Model & Client

- **Model:** `deepseek-v4-flash` (thinking mode)
- **Alternative:** `deepseek-v4-pro` for deeper reasoning (configurable via env)
- **Client:** `openai` npm package configured with `baseURL: "https://api.deepseek.com"`
- **API Key:** `DEEPSEEK_API_KEY` env var (existing)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
});
```

### 4.2 Thinking Mode Parameters

> **CRITICAL:** Thinking mode ignores `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` — they do not error but have NO effect. Perspective diversity MUST come from prompt framing, not temperature.

```ts
const response = await client.chat.completions.create({
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  max_tokens: 4096,
  response_format: { type: "json_object" },
  thinking: { type: "enabled" },
  reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT ?? "high", // "high" | "max"
  messages: [
    { role: "system", content: PERSPECTIVE_SYSTEM_PROMPTS[perspective] },
    { role: "user", content: JSON.stringify({ ddReport, graphPatterns, markPrice }) },
  ],
});
```

Chain-of-thought is returned separately in `response.choices[0].message.reasoning_content` (NOT in `content`). The `content` field holds the final JSON output. Planning Agent logs `reasoning_content` for debugging but does NOT include it in `TradePlan` output (internal only).

### 4.3 Three Perspective Runs

Run in parallel. Each gets a different system prompt framing the LLM's analysis lens:

| Perspective | Prompt Framing |
|---|---|
| `conservative` | Prioritize capital preservation. Demand stronger evidence before bullish/short thesis. Lean toward smaller position sizes, tighter leverage caps. Flag risk aggressively. |
| `balance` | Weigh all factors equally. Neutral stance on risk appetite. Standard evidence threshold. |
| `aggressive` | Prioritize opportunity capture. Accept moderate evidence for thesis. Lean toward larger positions (within risk engine limits) and higher leverage. |

Each perspective returns `PerspectiveResult`:
```json
{
  "side": "long",
  "thesis": "BTC setup bullish moderat...",
  "reasoning": "Technical confirmation + neutral funding +...",
  "confidence_breakdown": {
    "factor_alignment": 75,
    "historical_match": 60,
    "signal_strength": 80
  },
  "leverage_suggested": 3,
  "risk_flags": ["funding cost elevated", "24h volume below 30d average"]
}
```

### 4.4 Aggregator LLM Call

Runs after all 3 perspectives complete. Synthesizes into a single `AggregatedReasoning`:

```ts
const response = await client.chat.completions.create({
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  max_tokens: 4096,
  response_format: { type: "json_object" },
  thinking: { type: "enabled" },
  reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT ?? "high",
  messages: [
    { role: "system", content: AGGREGATOR_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ perspectives, ddReport, graphPatterns }) },
  ],
});
```

Returns:
```json
{
  "side": "long",
  "thesis": "Consensus across 3 perspectives: moderate bullish...",
  "reasoning": "Conservative flagged funding risk; balance and aggressive agreed on technical confirmation...",
  "confidence_score": 72,
  "confidence_breakdown": {
    "factor_alignment": 75,
    "historical_match": 60,
    "signal_strength": 80
  },
  "leverage_suggested": 3,
  "risk_flags": ["funding cost elevated", "24h volume below 30d average"]
}
```

**Self-consistency signal:** If all 3 perspectives agree on `side`, aggregator confidence gets implicit boost (aggregator prompt notes agreement level). If perspectives diverge on side, aggregator must flag high uncertainty and confidence_breakdown.signal_strength drops.

### 4.5 Prompt Strategy

System prompts stored as constants in `lib/agent/planning/prompts.ts`:
- `PERSPECTIVE_SYSTEM_PROMPTS: { conservative: string, balance: string, aggressive: string }`
- `AGGREGATOR_SYSTEM_PROMPT: string`

Per-perspective prompts instruct the LLM to:
- Output `side: "long" | "short"` (never "hold" — if no trade, return side with low confidence and risk_flags explaining why)
- Write 2-4 sentence thesis grounded in DDReport sections
- Score confidence_breakdown per component (0-100 each)
- Suggest leverage (1-20 range — risk engine will cap)
- List risk_flags as specific strings
- Return valid JSON matching `PerspectiveResult` shape
- NOT output entry price, position size, SL, or TP (deterministic code handles these)

Aggregator prompt instructs the LLM to:
- Note agreement/divergence across the 3 perspectives
- Output a single consensus `side`, `thesis`, `reasoning`
- Output final `confidence_score` (0-100) reflecting both factor quality AND perspective agreement
- Output final `confidence_breakdown` (consensus of 3 perspective breakdowns)
- Output final `leverage_suggested` (consensus)
- Merge and deduplicate `risk_flags` from all 3 perspectives
- Return valid JSON matching `AggregatedReasoning` shape

### 4.6 Error Handling for LLM

| Error | Strategy |
|---|---|
| JSON parse failure | Retry once with explicit "Output ONLY valid JSON" instruction; if still fails, perspective returns fallback `{ side: "long", thesis: "LLM parse error", confidence_breakdown: {factor_alignment:50, historical_match:50, signal_strength:50}, leverage_suggested: 1, risk_flags: ["llm_parse_error"] }` |
| API timeout (30s — thinking mode is slower) | Retry once; if retry times out, mark perspective as error and continue with remaining perspectives (aggregator handles partial input) |
| Rate limit (429) | Exponential backoff: 2s → 4s → 8s; max 3 retries |
| 5xx server error | Retry once; after 2 failures, skip perspective and flag in risk_flags |
| All 3 perspectives fail | Return error response (500), do NOT fabricate TradePlan |
| Aggregator fails | Return error response (500); do NOT fall back to single-perspective output |

---

## 5. Output Schema (TradePlan)

The Planning Agent output is a `TradePlan`, validated with Zod. Schema lives in `lib/agent/types.ts` (shared with Execution Agent):

```ts
// lib/agent/types.ts — ADD to existing file
import { z } from "zod";

export const GraphPatternSchema = z.object({
  pattern: z.string(),
  outcome: z.string(),
  frequency: z.number().int().min(0),
});

export const ConfidenceBreakdownSchema = z.object({
  factor_alignment: z.number().int().min(0).max(100),
  historical_match: z.number().int().min(0).max(100),
  signal_strength: z.number().int().min(0).max(100),
});

export const RiskThresholdsSchema = z.object({
  confidence_threshold: z.number().int().min(0).max(100),
  max_position_usdc: z.number().positive(),
  max_leverage: z.number().int().min(1).max(50),
  risk_per_trade_percent: z.number().min(0).max(100),
});

export const TradePlanSchema = z.object({
  asset: z.string(),
  side: z.enum(["long", "short"]),
  entry_price: z.number().positive(),
  position_size_usdc: z.number().positive(),
  position_size_contracts: z.number().positive(),
  stop_loss: z.number().positive(),
  take_profit: z.number().positive(),
  leverage: z.number().int().min(1).max(50),
  confidence_score: z.number().int().min(0).max(100),
  confidence_breakdown: ConfidenceBreakdownSchema,
  thesis: z.string(),
  reasoning: z.string(),
  autonomy_decision: z.enum(["auto", "approve"]),
  risk_flags: z.array(z.string()),
  graph_patterns_used: z.array(GraphPatternSchema),
  timestamp: z.string().datetime(),
  errors: z.array(z.string()).optional(),
});

export type TradePlan = z.infer<typeof TradePlanSchema>;
```

> **Why in `lib/agent/types.ts`:** Execution Agent (future) must validate `TradePlan` before placing orders — importing the schema from the shared agent types layer avoids coupling to Planning internals. Mirrors how `DDReportSchema` already lives there for DD→Planning handoff.

Example output:
```json
{
  "asset": "BTC",
  "side": "long",
  "entry_price": 65230.5,
  "position_size_usdc": 50.00,
  "position_size_contracts": 0.000767,
  "stop_loss": 64230.5,
  "take_profit": 68230.5,
  "leverage": 3,
  "confidence_score": 72,
  "confidence_breakdown": {
    "factor_alignment": 75,
    "historical_match": 60,
    "signal_strength": 80
  },
  "thesis": "Consensus across 3 perspectives: moderate bullish setup...",
  "reasoning": "Conservative flagged funding risk; balance and aggressive agreed on technical confirmation...",
  "autonomy_decision": "approve",
  "risk_flags": ["funding cost elevated"],
  "graph_patterns_used": [
    { "pattern": "RSI oversold + funding neutral", "outcome": "profit_2pct", "frequency": 4 }
  ],
  "timestamp": "2026-07-17T10:05:00Z",
  "errors": []
}
```

---

## 6. TypeScript Interfaces

### 6.1 Shared Inter-Agent Contracts (`lib/agent/types.ts`)

Types consumed across agents live here, mirroring how `DDReport` is already shared between DD and Planning. Adding `TradePlan` (Planning output → consumed by Execution later) and `RiskThresholds` (queried by Planning + Execution).

```ts
// lib/agent/types.ts — ADD to existing file (do not remove DDReport, SectionResult, etc.)

export type Side = "long" | "short";
export type AutonomyDecision = "auto" | "approve";

export interface ConfidenceBreakdown {
  factor_alignment: number;   // 0-100
  historical_match: number;   // 0-100
  signal_strength: number;    // 0-100
}

export interface RiskThresholds {
  confidence_threshold: number;      // 0-100
  max_position_usdc: number;
  max_leverage: number;
  risk_per_trade_percent: number;    // 0-100 (e.g. 1 = 1%)
}

export interface TradePlan {
  asset: string;
  side: Side;
  entry_price: number;
  position_size_usdc: number;
  position_size_contracts: number;
  stop_loss: number;
  take_profit: number;
  leverage: number;
  confidence_score: number;
  confidence_breakdown: ConfidenceBreakdown;
  thesis: string;
  reasoning: string;
  autonomy_decision: AutonomyDecision;
  risk_flags: string[];
  graph_patterns_used: GraphPattern[];
  timestamp: string;
  errors?: string[];
}
```

> **Why shared:** `TradePlan` is the Planning Agent's output contract that the Execution Agent (future spec) will consume — placing it in `lib/agent/planning/types.ts` would force Execution to import from a sibling agent's folder, creating tight coupling. `RiskThresholds` is queried by both Planning (gate logic) and Execution (position size validation). `Side`, `AutonomyDecision`, `ConfidenceBreakdown` are primitives of these shared contracts.
>
> **`GraphPattern`** stays here too (referenced by `TradePlan.graph_patterns_used`) so Execution can interpret the patterns without importing from Planning internals.

```ts
// lib/agent/types.ts — also add

export interface GraphPattern {
  pattern: string;
  outcome: string;
  frequency: number;
}
```

### 6.2 Planning-Internal Types (`lib/agent/planning/types.ts`)

Internal to the Planning Agent — never imported by other agents.

```ts
// lib/agent/planning/types.ts

import type { DDReport, TradePlan, Side, ConfidenceBreakdown, GraphPattern } from "@/lib/agent/types";

export type Perspective = "conservative" | "balance" | "aggressive";

export interface PerspectiveResult {
  side: Side;
  thesis: string;
  reasoning: string;
  confidence_breakdown: ConfidenceBreakdown;
  leverage_suggested: number;
  risk_flags: string[];
}

export interface AggregatedReasoning {
  side: Side;
  thesis: string;
  reasoning: string;
  confidence_score: number;       // 0-100
  confidence_breakdown: ConfidenceBreakdown;
  leverage_suggested: number;
  risk_flags: string[];
}

export interface PlanningPipelineInput {
  ddReport: DDReport;
  userId: string;
  walletAddress: string;
}

export interface PlanningPipelineOutput {
  plan: TradePlan;
  timing: {
    fetchMs: number;
    graphMs: number;
    llmMs: number;
    riskEngineMs: number;
    totalMs: number;
  };
}
```

> **Why internal:** `PerspectiveResult`, `AggregatedReasoning`, `PlanningPipelineInput`, `PlanningPipelineOutput` describe the Planning pipeline's internal shape — no other agent needs them. They live next to the pipeline implementation that produces and consumes them.

### 6.3 Risk Engine Types

```ts
// lib/agent/planning/risk-engine.ts

import type { Side } from "@/lib/agent/types";

export interface ATRResult {
  atr: number;
  period: number;
}

export interface RiskEngineInput {
  entry: number;
  atr: number;
  side: Side;
  equity: number;
  riskPercent: number;       // from risk_per_trade_percent
  leverageSuggested: number; // LLM output
  maxLeverage: number;       // from thresholds
}

export interface RiskEngineOutput {
  stop_loss: number;
  take_profit: number;
  position_size_usdc: number;
  position_size_contracts: number;
  leverage: number;
}
```

### 6.4 ArangoDB Document Types

```ts
// lib/db/arango-types.ts

import type { RiskThresholds, Side } from "@/lib/agent/types";

export interface RiskThresholdsDoc extends RiskThresholds {
  userId: string;
  _key?: string;
  _id?: string;
}

export interface DecisionNode {
  _key?: string;
  _id?: string;
  asset: string;
  category: string;
  side: Side;
  confidence_score: number;
  timestamp: string;
  outcome?: string; // filled after close
  pnl?: number;
}

export interface SignalNode {
  _key?: string;
  _id?: string;
  name: string;
  factor: string;
}

export interface OutcomeNode {
  _key?: string;
  _id?: string;
  result: string;
  pnl: number;
  timestamp: string;
}

export interface AssetNode {
  _key?: string;
  _id?: string;
  symbol: string;
  category: string;
}
```

---

## 7. File & Module Structure

**Principle:**
- `lib/agent/types.ts` = **shared inter-agent contracts** (output schemas consumed by other agents)
- `lib/agent/<agent>/types.ts` = **agent-internal types** (never imported by other agents)
- `lib/db/` = **shared infrastructure** (DB client, collection queries — used by multiple agents)
- `lib/data/` = **shared data sources** (HL SDK, CoinGecko, etc. — used by multiple agents)

```
lib/
├── agent/
│   ├── types.ts                    # SHARED — inter-agent contracts
│   │                               #   EXISTING: DDReport, SectionResult, SectionResultSchema, DDReportSchema
│   │                               #   NEW: TradePlan, TradePlanSchema (Planning output → consumed by Execution)
│   │                               #        RiskThresholds, RiskThresholdsSchema (shared — queried by Planning + Execution)
│   ├── pipeline.ts                 # EXISTING — re-exports runDDPipeline
│   ├── due-diligence/              # EXISTING — DD Agent modules
│   └── planning/                   # NEW — Planning Agent (planning-specific only)
│       ├── types.ts                # INTERNAL: PerspectiveResult, AggregatedReasoning, GraphPattern,
│       │                           #   RiskEngineInput, PlanningPipelineInput, PlanningPipelineOutput
│       ├── pipeline.ts             # runPlanningPipeline(input) → main orchestrator
│       ├── prompts.ts              # PERSPECTIVE_SYSTEM_PROMPTS, AGGREGATOR_SYSTEM_PROMPT
│       ├── llm.ts                  # runPerspective(), synthesizePerspectives() — DeepSeek thinking-mode calls
│       ├── risk-engine.ts          # computeATR(), computeSL_TP(), computePositionSize(), capLeverage()
│       └── gate.ts                 # decideAutonomy(confidence, positionSize, thresholds) → "auto" | "approve"
├── data/
│   ├── hyperliquid.ts              # EXISTING — extend with fetchMarkPrice(), fetchUserEquity()
│   └── ...                         # EXISTING — DD data providers
├── db/                             # NEW — ArangoDB layer (shared infra)
│   ├── arango-client.ts            # getDb() singleton, connection config
│   ├── arango-types.ts             # RiskThresholdsDoc, DecisionNode, SignalNode, OutcomeNode, AssetNode
│   ├── risk-thresholds.ts          # getRiskThresholds(userId) → RiskThresholds | null
│   └── graph-memory.ts             # queryGraphPatterns(asset, category, signals) → GraphPattern[]
└── ...                             # EXISTING — cache.ts, utils.ts, asset-categories.ts

app/
└── api/
    └── agent/
        ├── dd/
        │   └── route.ts            # EXISTING — POST /api/agent/dd
        └── planning/
            └── route.ts            # NEW — POST /api/agent/planning
```

---

## 8. Pipeline Orchestration

### 8.1 `runPlanningPipeline(input: PlanningPipelineInput): Promise<PlanningPipelineOutput>`

```ts
// lib/agent/planning/pipeline.ts

import { fetchMarkPrice, fetchCandles, fetchUserEquity } from "@/lib/data/hyperliquid";
import { getRiskThresholds } from "@/lib/db/risk-thresholds";
import { queryGraphPatterns } from "@/lib/db/graph-memory";
import { runPerspective, synthesizePerspectives } from "./llm";
import { computeATR, computeSL_TP, computePositionSize, capLeverage } from "./risk-engine";
import { decideAutonomy } from "./gate";
import { getDefaultRiskThresholds } from "./risk-engine"; // env fallback
import type { TradePlan, RiskThresholds, GraphPattern } from "@/lib/agent/types";
import type { PlanningPipelineInput, PlanningPipelineOutput, PerspectiveResult, AggregatedReasoning } from "./types";

const PERSPECTIVES = ["conservative", "balance", "aggressive"] as const;

export async function runPlanningPipeline(
  input: PlanningPipelineInput
): Promise<PlanningPipelineOutput> {
  const t0 = Date.now();
  const { ddReport, userId, walletAddress } = input;
  const errors: string[] = [];

  // 1. Parallel fetch: mark price, candles, equity, risk thresholds
  const fetchStart = Date.now();
  const [markPrice, candles, equity, storedThresholds] = await Promise.all([
    fetchMarkPrice(ddReport.asset).catch((e) => { errors.push(`mark_price: ${e.message}`); throw e; }),
    fetchCandles(ddReport.asset, "1h", 96).catch((e) => { errors.push(`candles: ${e.message}`); throw e; }),
    fetchUserEquity(walletAddress).catch((e) => { errors.push(`equity: ${e.message}`); throw e; }),
    getRiskThresholds(userId).catch((e) => { errors.push(`thresholds: ${e.message}`); return null; }),
  ]);
  const fetchMs = Date.now() - fetchStart;

  const thresholds = storedThresholds ?? getDefaultRiskThresholds();

  // 2. Graph Memory query (parallel with perspective LLM calls below)
  const graphStart = Date.now();
  const allSignals = Object.values(ddReport.sections).flatMap((s) => s.signals);
  const graphPatterns = await queryGraphPatterns(
    ddReport.asset,
    ddReport.category,
    allSignals
  ).catch((e) => { errors.push(`graph: ${e.message}`); return []; });
  const graphMs = Date.now() - graphStart;

  // 3. Three perspective LLM runs in parallel (thinking mode)
  const llmStart = Date.now();
  const perspectivePromises = PERSPECTIVES.map((p) =>
    runPerspective(p, ddReport, graphPatterns, markPrice).catch((e) => {
      errors.push(`perspective_${p}: ${e.message}`);
      return null;
    })
  );
  const perspectiveResults = await Promise.all(perspectivePromises);
  const validPerspectives = perspectiveResults.filter((p): p is NonNullable<typeof p> => p !== null);

  if (validPerspectives.length === 0) {
    throw new Error("All 3 perspective LLM calls failed — cannot produce TradePlan");
  }

  // 4. Aggregator LLM call (thinking mode)
  const aggregated = await synthesizePerspectives(validPerspectives, ddReport, graphPatterns);
  const llmMs = Date.now() - llmStart;

  // 5. Deterministic risk engine
  const riskStart = Date.now();
  const atr = computeATR(candles, Number(process.env.ATR_PERIOD ?? 14));
  const { stop_loss, take_profit } = computeSL_TP(markPrice, atr, aggregated.side, {
    slMultiplier: Number(process.env.ATR_SL_MULTIPLIER ?? 1.5),
    tpMultiplier: Number(process.env.ATR_TP_MULTIPLIER ?? 3.0),
  });
  const { position_size_usdc, position_size_contracts } = computePositionSize({
    equity,
    riskPercent: thresholds.risk_per_trade_percent,
    entry: markPrice,
    stopLoss: stop_loss,
    side: aggregated.side,
  });
  const leverage = capLeverage(aggregated.leverage_suggested, thresholds.max_leverage);
  const riskEngineMs = Date.now() - riskStart;

  // 6. Autonomy gate
  const autonomy_decision = decideAutonomy({
    confidence: aggregated.confidence_score,
    positionSizeUsdc: position_size_usdc,
    thresholds,
  });

  // 7. Assemble TradePlan
  const plan: TradePlan = {
    asset: ddReport.asset,
    side: aggregated.side,
    entry_price: markPrice,
    position_size_usdc,
    position_size_contracts,
    stop_loss,
    take_profit,
    leverage,
    confidence_score: aggregated.confidence_score,
    confidence_breakdown: aggregated.confidence_breakdown,
    thesis: aggregated.thesis,
    reasoning: aggregated.reasoning,
    autonomy_decision,
    risk_flags: aggregated.risk_flags,
    graph_patterns_used: graphPatterns,
    timestamp: new Date().toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  };

  return {
    plan,
    timing: {
      fetchMs,
      graphMs,
      llmMs,
      riskEngineMs,
      totalMs: Date.now() - t0,
    },
  };
}
```

### 8.2 API Route

```ts
// app/api/agent/planning/route.ts

import { NextRequest, NextResponse } from "next/server";
import { runPlanningPipeline } from "@/lib/agent/planning/pipeline";
import { TradePlanSchema } from "@/lib/agent/types";
import { DDReportSchema } from "@/lib/agent/types";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ddReport, userId, walletAddress } = body;

  if (!ddReport || !userId || !walletAddress) {
    return NextResponse.json(
      { error: "ddReport, userId, and walletAddress required" },
      { status: 400 }
    );
  }

  // Validate input DDReport
  const parsedDdReport = DDReportSchema.safeParse(ddReport);
  if (!parsedDdReport.success) {
    return NextResponse.json(
      { error: "Invalid DDReport", detail: parsedDdReport.error.flatten() },
      { status: 422 }
    );
  }

  try {
    const output = await runPlanningPipeline({
      ddReport: parsedDdReport.data,
      userId,
      walletAddress,
    });
    const parsed = TradePlanSchema.parse(output.plan);
    return NextResponse.json({ ...output, plan: parsed });
  } catch (err) {
    console.error("Planning pipeline error:", err);
    return NextResponse.json(
      { error: "Planning pipeline failed", detail: String(err) },
      { status: 500 }
    );
  }
}
```

### 8.3 Risk Engine Functions

```ts
// lib/agent/planning/risk-engine.ts

export function computeATR(candles: CandleData[], period: number = 14): number {
  if (candles.length < period + 1) {
    throw new Error(`Insufficient candles for ATR(${period}): got ${candles.length}`);
  }
  // Wilder's smoothing
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  // First ATR = simple average of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  // Subsequent ATRs use Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

export function computeSL_TP(
  entry: number,
  atr: number,
  side: Side,
  opts: { slMultiplier: number; tpMultiplier: number }
): { stop_loss: number; take_profit: number } {
  if (side === "long") {
    return {
      stop_loss: entry - atr * opts.slMultiplier,
      take_profit: entry + atr * opts.tpMultiplier,
    };
  }
  return {
    stop_loss: entry + atr * opts.slMultiplier,
    take_profit: entry - atr * opts.tpMultiplier,
  };
}

export function computePositionSize(opts: {
  equity: number;
  riskPercent: number;
  entry: number;
  stopLoss: number;
  side: Side;
}): { position_size_usdc: number; position_size_contracts: number } {
  const riskAmount = opts.equity * (opts.riskPercent / 100);
  const perUnitRisk = Math.abs(opts.entry - opts.stopLoss);
  if (perUnitRisk === 0) {
    throw new Error("Entry and stop loss are equal — cannot compute position size");
  }
  const contracts = riskAmount / perUnitRisk;
  const usdc = contracts * opts.entry;
  return { position_size_usdc: usdc, position_size_contracts: contracts };
}

export function capLeverage(suggested: number, maxAllowed: number): number {
  return Math.max(1, Math.min(Math.floor(suggested), maxAllowed));
}

export function getDefaultRiskThresholds(): RiskThresholds {
  return {
    confidence_threshold: Number(process.env.RISK_CONFIDENCE_THRESHOLD ?? 70),
    max_position_usdc: Number(process.env.RISK_MAX_POSITION_USDC ?? 100),
    max_leverage: Number(process.env.RISK_MAX_LEVERAGE ?? 10),
    risk_per_trade_percent: Number(process.env.RISK_PER_TRADE_PERCENT ?? 1),
  };
}
```

### 8.4 Autonomy Gate

```ts
// lib/agent/planning/gate.ts

import type { AutonomyDecision, RiskThresholds } from "./types";

export function decideAutonomy(args: {
  confidence: number;
  positionSizeUsdc: number;
  thresholds: RiskThresholds;
}): AutonomyDecision {
  const { confidence, positionSizeUsdc, thresholds } = args;
  if (
    confidence >= thresholds.confidence_threshold &&
    positionSizeUsdc <= thresholds.max_position_usdc
  ) {
    return "auto";
  }
  return "approve";
}
```

---

## 9. Error Handling & Resilience

### 9.1 Per-Source Degradation

| Source Failure | Handling |
|---|---|
| Hyperliquid mark price fetch fails | Fatal — cannot compute entry. Return 500. |
| Hyperliquid candles fetch fails | Fatal — cannot compute ATR/SL/TP. Return 500. |
| Hyperliquid equity fetch fails | Fatal — cannot compute position size. Return 500. |
| ArangoDB unavailable | Non-fatal — `graph_patterns_used: []`, `confidence_breakdown.historical_match: 50` (neutral), flag in `errors[]`. Pipeline continues. |
| `risk_thresholds` document missing | Non-fatal — fall back to env defaults. No error flag (this is expected for new users). |
| 1-2 perspectives fail | Non-fatal — aggregator handles 2 or 1 remaining perspectives. Flag in `errors[]`. |
| All 3 perspectives fail | Fatal — return 500. Do NOT fabricate TradePlan. |
| Aggregator fails | Fatal — return 500. Do NOT fall back to single perspective. |

### 9.2 Partial Validity

A `TradePlan` with `errors: ["graph: connection refused", "perspective_conservative: timeout"]` is still valid IF:
- At least 1 perspective succeeded (aggregator can synthesize from 1-3 perspectives)
- All deterministic numbers (entry, SL, TP, size, leverage) computed successfully

### 9.3 Timeouts

- Mark price / equity / candle fetch: 10s each
- ArangoDB query: 5s
- Each perspective LLM call (thinking mode): 30s — thinking mode is slower than non-thinking
- Aggregator LLM call: 30s
- Pipeline total: 90s hard deadline (4× thinking mode calls are expensive)

### 9.4 ATR Edge Cases

| Edge Case | Handling |
|---|---|
| Insufficient candles (< period+1) | Throw error — Planning Agent requires min 15 candles for ATR(14) |
| ATR = 0 (flat market) | Throw error — cannot compute meaningful SL/TP |
| Computed SL > entry (long) or SL < entry (short) | Mathematically impossible if ATR > 0, but assert in code |

---

## 10. Commands & Environment Variables

### 10.1 Commands

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `npm test` | Run vitest |
| `npm run test:watch` | Vitest watch mode |

### 10.2 New Dependency

```
npm install arangojs
```

### 10.3 New Environment Variables

Add to `.env` and `.env.example`:

```bash
# === ArangoDB (Graph Memory + risk thresholds) ===
ARANGO_URL=http://127.0.0.1:8529
ARANGO_DB=odin
ARANGO_USER=root
ARANGO_PASSWORD=

# === DeepSeek thinking mode ===
DEEPSEEK_REASONING_EFFORT=high        # "high" (default) | "max" (deeper, slower, costlier)

# === Risk engine defaults (fallback when user has no risk_thresholds in ArangoDB) ===
RISK_CONFIDENCE_THRESHOLD=70          # min confidence (0-100) for auto-execute
RISK_MAX_POSITION_USDC=100            # max position size in USDC for auto-execute
RISK_MAX_LEVERAGE=10                  # hard cap on leverage regardless of LLM suggestion
RISK_PER_TRADE_PERCENT=1              # fixed-fractional: 1 = risk 1% equity per trade

# === ATR-based SL/TP ===
ATR_PERIOD=14                         # ATR lookback periods (Wilder's smoothing)
ATR_CANDLE_INTERVAL=1h                # candle interval for ATR (1h, 15m, 1d)
ATR_SL_MULTIPLIER=1.5                 # SL distance = ATR × multiplier
ATR_TP_MULTIPLIER=3.0                 # TP distance = ATR × multiplier (3:1 R:R default)

# === Self-consistency (3 perspectives) ===
SELF_CONSISTENCY_PERSPECTIVES=3       # number of perspective LLM runs (fixed: conservative/balance/aggressive)
SELF_CONSISTENCY_TIMEOUT_MS=30000     # per-perspective call timeout (thinking mode is slower)
```

### 10.4 Existing Variables (reused, no change)

```bash
DEEPSEEK_API_KEY=...                  # existing
DEEPSEEK_BASE_URL=https://api.deepseek.com   # existing
DEEPSEEK_MODEL=deepseek-v4-flash      # existing — Planning Agent uses same model in thinking mode
HYPERLIQUID_TESTNET=true              # existing — set false for mainnet equity fetch
```

---

## 11. Implementation Phases

### Phase 1: Foundation (deterministic layer)
- `lib/db/arango-client.ts` — connection singleton
- `lib/db/risk-thresholds.ts` — `getRiskThresholds(userId)`
- `lib/data/hyperliquid.ts` — add `fetchMarkPrice()`, `fetchUserEquity()`
- `lib/agent/planning/types.ts` — all type defs + Zod schemas
- `lib/agent/planning/risk-engine.ts` — `computeATR`, `computeSL_TP`, `computePositionSize`, `capLeverage`, `getDefaultRiskThresholds`
- `lib/agent/planning/gate.ts` — `decideAutonomy()`

**Checkpoint:** Unit test risk engine: given equity=1000, riskPct=1, entry=65000, SL=64000 → position_size_usdc=65, contracts=0.001. ATR computation matches manual calc.

### Phase 2: Graph Memory (ArangoDB)
- `lib/db/graph-memory.ts` — `queryGraphPatterns(asset, category, signals)`
- ArangoDB collection initialization script (document + graph collections)
- AQL query for historical pattern lookup
- Empty-graph handling (return `[]`, neutral confidence)

**Checkpoint:** With empty ArangoDB, `queryGraphPatterns("BTC", "major", ["RSI oversold"])` returns `[]` without error. With seeded test data, returns `[{ pattern, outcome, frequency }]`.

### Phase 3: LLM Layer (thinking mode)
- `lib/agent/planning/prompts.ts` — 3 perspective prompts + aggregator prompt
- `lib/agent/planning/llm.ts` — `runPerspective()`, `synthesizePerspectives()`
- DeepSeek thinking mode integration (`thinking: { type: "enabled" }`, `reasoning_effort`)
- JSON parse + retry logic
- `reasoning_content` logging (debug only, not in output)

**Checkpoint:** Mock DeepSeek client → 3 perspectives return valid JSON, aggregator synthesizes. Real DeepSeek call with thinking mode returns `reasoning_content` populated.

### Phase 4: Pipeline Orchestration
- `lib/agent/planning/pipeline.ts` — `runPlanningPipeline()`
- `app/api/agent/planning/route.ts` — POST endpoint
- End-to-end: DDReport input → fetch all data → 3 perspectives + aggregator → risk engine → gate → TradePlan output

**Checkpoint:** `POST /api/agent/planning` with a valid DDReport + testnet walletAddress → returns valid `TradePlan` JSON within 60s. Run for BTC, verify entry=mark price, SL/TP = ATR-based, size = fixed-fractional.

### Phase 5: Error Resilience & Tests (Stretch)
- Per-source degradation tests (ArangoDB down, 1 perspective fail, etc.)
- Timeout handling
- Integration test against Hyperliquid testnet + local ArangoDB

**Checkpoint:** Kill ArangoDB mid-run → pipeline still returns TradePlan with `errors: ["graph: ..."]` and `graph_patterns_used: []`.

---

## 12. Testing Strategy

- **Unit tests:**
  - Risk engine: `computeATR`, `computeSL_TP` (long/short), `computePositionSize`, `capLeverage`
  - Gate: `decideAutonomy` (auto vs approve boundary cases)
  - Graph memory: AQL query with seeded test data + empty graph
  - Risk thresholds: ArangoDB hit + env fallback
  - LLM: mock OpenAI client, thinking mode params verified, JSON parse + retry
  - Zod schema validation: valid + invalid TradePlan shapes

- **Integration test:**
  - Full pipeline run against Hyperliquid testnet + local ArangoDB for 1 asset (BTC)
  - Verify timing breakdown (fetchMs, graphMs, llmMs, riskEngineMs)
  - Verify all TradePlan fields populated correctly

- **No E2E at this stage** — dashboard/approval UI comes later

Test framework: **vitest** (existing). Test locations: `__tests__/lib/agent/planning/` and `__tests__/app/api/agent/planning/`.

---

## 13. Boundaries

- **Always:**
  - Validate input `DDReport` against Zod schema before processing
  - Validate output `TradePlan` against Zod schema before returning
  - Use deterministic code for entry price, SL/TP, position size, leverage cap (NEVER LLM for these)
  - Log `reasoning_content` from thinking mode for debugging (do NOT include in TradePlan output)
  - Handle ArangoDB unavailability gracefully (non-fatal, continue with empty patterns)
  - Wrap all external calls with `withTimeout` / `withRetry` from `lib/utils.ts`

- **Ask first:**
  - Changing DeepSeek model from `deepseek-v4-flash` to `deepseek-v4-pro`
  - Changing `reasoning_effort` from `high` to `max`
  - Changing number of perspectives (currently fixed at 3: conservative/balance/aggressive)
  - Adding new ArangoDB collections beyond spec §9
  - Modifying TradePlan schema fields

- **Never:**
  - Let LLM output entry price, SL, TP, or position size directly
  - Skip Zod validation on input or output
  - Hardcode API keys or ArangoDB credentials
  - Call Execution Agent from Planning Agent (boundary — Execution is separate spec)
  - Store pending plans to ArangoDB (out of scope — frontend/approval concern)
  - Include `reasoning_content` or `perspective_runs` in TradePlan output (internal only)

---

## 14. Resolved Decisions

1. **ArangoDB scope: Full integration.** Install `arangojs`, design collections (decisions/signals/outcomes/assets + edge collections), write real AQL queries. User runs ArangoDB instance locally. Graph Memory is live, not mocked. (Interview Q1)

2. **Equity source: Real fetch via HL SDK.** Input includes `walletAddress`. Planning Agent calls `InfoClient.userClearingState(walletAddress)` to get equity. No SIWE auth needed yet — userId-based stub auth sufficient. (Interview Q2)

3. **ATR data source: Planning Agent re-fetches candles via HL SDK.** DDReport schema is locked (no ATR field), price moves between DD and Planning run, `fetchCandles` already exists in `lib/data/hyperliquid.ts`. Fresh volatility data. (Interview Q3)

4. **Self-consistency: 3 perspective runs + 1 aggregator (4 LLM calls total).** NOT spec §6's generic 2-3x temperature variance. Three perspectives (conservative, balance, aggressive) differ via PROMPT FRAMING — thinking mode ignores `temperature`, so diversity must come from prompt-level lens. Aggregator synthesizes consensus. (Interview Q4 + Q6)

5. **Spec stop-point: Gate decision only.** Planning Agent returns `TradePlan` + `autonomy_decision: "auto" | "approve"`. Does NOT call Execution Agent, does NOT store pending plan. Clean boundary: Planning = think/decide, Execution = act (separate spec). Approval flow = frontend concern. (Interview Q5)

6. **DeepSeek thinking mode params:** `thinking: { type: "enabled" }` + `reasoning_effort: "high" | "max"`. Chain of thought in `response.choices[0].message.reasoning_content` (separate from `content`). Thinking mode ignores `temperature`/`top_p`/`presence_penalty`/`frequency_penalty` — perspective diversity via prompt framing. (Interview Q6, verified via context7 research)

7. **TradePlan output schema: Approved as specified in §5.** No `perspective_runs` in output (internal only). `graph_patterns_used` included. `confidence_breakdown` has 3 components: factor_alignment, historical_match, signal_strength. (Interview Q7)

8. **Entry price: Deterministic current mark price.** Fetched via HL SDK (`allMids` or `l2Book`). LLM never touches entry price. Anti-hallucination principle: critical numbers = deterministic code. (Interview Q8)

9. **Leverage: LLM suggests, risk engine caps.** LLM outputs `leverage_suggested` as part of reasoning. Deterministic risk engine caps it: `final_leverage = min(LLM_suggested, max_allowed)`. LLM has input but final value is deterministic. (Interview Q9)

10. **Risk thresholds: ArangoDB + env fallback.** Query `risk_thresholds` collection per userId. If document null/missing (new user), fall back to env defaults. Consistent with spec §13 per-user configurability + Q1 full ArangoDB integration. (Interview Q10)

11. **Graph Memory empty state: Neutral confidence, not zero.** On first run with empty graph, `queryGraphPatterns` returns `[]`. `confidence_breakdown.historical_match` defaults to 50 (neutral — no prior data neither helps nor hurts). Graph populates over time as Execution Agent records outcomes.

12. **`reasoning_content` logging: Debug only.** DeepSeek thinking mode returns chain-of-thought in `reasoning_content`. Planning Agent logs it for debugging/audit but does NOT include it in `TradePlan` output. Keeps API response clean and avoids leaking internal reasoning to downstream consumers.

---

*Spec relates to: `docs/odin-spec.md` §4.2 (Planning & Decision Agent), §6 (Metodologi Planning & Decision), §7 (DD Report format), §8 (Graph Memory), §9 (Database Strategy), §13 (Autonomy Gating Logic), §14 (LLM Model), §17 (Tech Stack), §18 (MVP Scope)*
