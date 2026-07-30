# Planning Agent Refactor Spec

Convert linear pipeline into multi-perspective swarm agent with ReAct loop and 2-layer consensus evaluation.

---

## 1. Motivation

**Current:** `runPlanningPipeline()` in `lib/agent/planning/pipeline.ts` is a fixed linear pipeline:
`fetch market data (parallel) → 3 perspective LLM calls (parallel) → 1 aggregator LLM call → risk engine (deterministic) → autonomy gate`.

Problems:
- LLM cannot choose to gather more data. All market data fetched upfront, no iteration.
- No ReAct loop. Each perspective is one prompt-to-answer, not a reasoning cycle.
- No self-reflection. If all 3 perspectives disagree, the pipeline has no mechanism to re-run or cross-verify.
- Risk engine runs AFTER aggregation. The LLM never sees risk calculations, never validates whether SL/TP/position make sense.
- No NO_TRADE detection. If the asset is not worth trading (flat price, low volatility), the pipeline still produces a plan.
- Fixed 4 LLM calls always, even if earlier calls already failed.

**Target:** Multi-perspective swarm agent where each perspective (conservative, balance, aggressive) has its own subagent with a ReAct loop and tools. The orchestrator uses Plan-Execute-Reflect to coordinate. A 2-layer evaluation prevents low-quality plans from reaching the user.

---

## 2. Architecture: Multi-Perspective Swarm Pattern

```
POST /api/agent/planning { asset, userId, walletAddress, targetProfitPercent }
  │
  ├─ Step 0: Auto-call runDDAgent(asset, userId, walletAddress) -> DDReport
  │            If DD fails, planning stops with error.
  │
  └─ PlanningAgentMain.run()
       │
       ┌─ PLAN ─────────────────────────────────────────────────────┐
       │ LLM (v4-pro, thinking): decide which perspectives to       │
       │ deploy, what tools each gets, specific instruction per     │
       │ perspective. Receives DDReport + targetProfitPercent.      │
       │ Output: AgentPlan { subagents: SubagentPlan[] }            │
       └───────────────────────────────────────────────────────────┘
       │
       ┌─ EXECUTE (parallel) ──────────────────────────────────────┐
       │ ┌─ ConservativeSubAgent ────── PerspectiveReport ────┐    │
       │ │ ReAct loop, max 5                                    │    │
       │ │ Tools: risk engine + market data + Exa + funding +   │    │
       │ │        liquidation + sentiment                       │    │
       │ └─────────────────────────────────────────────────────┘    │
       │ ┌─ BalanceSubAgent ─────────── PerspectiveReport ────┐    │
       │ │ ReAct loop, max 5, same tools                       │    │
       │ └─────────────────────────────────────────────────────┘    │
       │ ┌─ AggressiveSubAgent ──────── PerspectiveReport ────┐    │
       │ │ ReAct loop, max 5, same tools                       │    │
       │ └─────────────────────────────────────────────────────┘    │
       └───────────────────────────────────────────────────────────┘
       │
       ┌─ AGGREGATE ───────────────────────────────────────────────┐
       │ LLM (v4-pro, thinking): merge 3 PerspectiveReports into    │
       │ AggregatedReasoning. Uses targetProfitPercent to validate  │
       │ that the plan's expected profit meets user expectations.   │
       │ Also computes: consensus alignment score, contradictions.  │
       └───────────────────────────────────────────────────────────┘
       │
       ┌─ EVALUATE (Layer 1: Consensus) ───────────────────────────┐
       │ Deterministic check:                                        │
       │   1. Consensus: do all 3 perspectives agree on side?       │
       │   2. Confidence: is aggregator confidence >= threshold?    │
       │   3. Profit: does expected profit meet targetProfitPercent?│
       │   4. NO_TRADE: is the market flat/uninteresting?           │
       │                                                             │
       │ Decision: ACCEPT / RE-DEPLOY / NO_TRADE / FAILED            │
       └───────────────────────────────────────────────────────────┘
       │
       ├─ RE-DEPLOY: rePlan for low-consensus perspectives with
       │   new instructions. Max re-deploy 2x per perspective.
       │
       ├─ NO_TRADE: return TradePlan { action: "NO_TRADE", ... }
       │   with reason (flat market, low volatility, overheated)
       │
       └─ ACCEPT: continue to Layer 2
            │
            ┌─ EVALUATE (Layer 2: Autonomy Gate) ──────────────────┐
            │ Deterministic: confidence >= threshold AND position   │
            │ size <= max position -> "auto", else -> "approve"     │
            └───────────────────────────────────────────────────────┘
            │
            Output: TradePlan {
              action: "LONG" | "SHORT" | "NO_TRADE",
              side, thesis, confidence_score, confidence_breakdown,
              stop_loss, take_profit, position_size_usdc,
              position_size_contracts, leverage,
              autonomy_decision, risk_flags, reasoning,
              entry_price, timestamp, errors?
            }
```

Key differences from current pipeline:
- **Step 0:** Planning agent now auto-calls DD agent internally. API route no longer receives `ddReport` in the body.
- **ReAct subagents:** Each perspective can call tools iteratively, not just one prompt-to-answer.
- **2-layer evaluation:** Layer 1 filters plan quality (is this a good plan?), Layer 2 decides who approves (auto or human?).
- **NO_TRADE:** The agent can conclude that the best trade is no trade.
- **targetProfitPercent:** User provides expected profit as percentage (e.g. 100 = 100%, not 0.01 = 1%). Agent uses this to filter plans.

---

## 3. Agent Loops

### 3.1 SubAgent: ReAct

```
LOOP (max 5):
  1. THINK:   LLM receives its perspective + available tools + DDReport
              + current state. Decides: which tool, with what parameters.
  2. ACT:     Execute the chosen tool with validated parameters.
  3. OBSERVE: Parse tool result into context for next iteration.
  4. REFLECT: Data enough? -> return PerspectiveReport.
              Not enough -> loop again.
              Loop 5 -> force return with whatever data was collected.
```

**LLM call per loop:** 1 (THINK step).
**Max LLM calls per subagent:** 5.
**Timeout per subagent:** 60s.
**Tool failure:** Record error in history, continue loop with remaining tools.

The ReAct loop is generic. Reuse the existing `runSubagent()` from `lib/agent/due-diligence/subagent.ts`. Planning perspective subagents use the same function with:
- `factor` = `"planning_conservative" | "planning_balance" | "planning_aggressive"`
- `tools` = planning-specific tool registry
- `maxLoops` = 5
- Custom `llmThink` and `getSystemPrompt` for planning context

### 3.2 Main Agent: Plan-Execute-Reflect

```
LOOP (max 5):
  1. PLAN:      LLM (v4-pro, thinking) receives DDReport + targetProfitPercent.
                Decides: which perspectives to deploy, instructions per perspective.
                Initial plan always deploys all 3 perspectives.
  2. EXECUTE:   Deploy subagents in parallel (Promise.all).
  3. AGGREGATE: LLM (v4-pro, thinking) merges 3 PerspectiveReports.
                Computes consensus alignment + contradictions.
  4. EVALUATE:  Layer 1 consensus check:
                - ACCEPT: all perspectives agree on side, confidence >= 60,
                  profit feasible for targetProfitPercent, no overheating.
                - RE-DEPLOY: 1-2 perspectives disagree or low confidence.
                  Targeted re-deploy for those perspectives.
                - NO_TRADE: market flat, ATR near zero, funding overheated,
                  or all perspectives return "no opportunity".
                - FAILED: all 3 perspectives failed or returned errors.
  5. RE-PLAN:   If RE-DEPLOY, generate new instructions for low-consensus
                perspectives only. Max 2 re-deploys per perspective.
```

---

## 4. Tool System

### 4.1 Tool Definition (reuse existing)

Same `ToolDefinition`, `ToolResult`, `ToolRegistry` from `lib/agent/tools/types.ts`. No new tool interface needed.

### 4.2 Risk Engine Tools (granular)

Convert the existing `lib/agent/planning/risk-engine.ts` from internal functions into separate tools. Each tool is deterministic (pure math, no LLM).

| Tool | Description | Parameters |
|------|-------------|------------|
| `compute_atr` | Average True Range from candle data | `asset`, `period` (default 14) |
| `compute_sltp` | Stop-loss and take-profit from entry + ATR + side | `entry`, `atr`, `side`, `slMultiplier` (default 1.5), `tpMultiplier` (default 3.0) |
| `compute_position_size` | Position size in USDC and contracts | `equity`, `entry`, `stopLoss`, `riskPercent` |
| `cap_leverage` | Cap LLM-suggested leverage to max allowed | `llmSuggested`, `maxAllowed` |

These let the LLM do "what-if" thinking:
1. Call `compute_atr` -> see volatility is 2.5% -> reasonable.
2. Try `compute_sltp(entry=100, atr=2.5, side="long")` -> SL at 96.25, TP at 107.5.
3. Check `compute_position_size(equity=5000, entry=100, stopLoss=96.25, riskPercent=5)` -> $1,333 USDC.
4. LLM evaluates: "RR ratio is 3:1, position size is 26% of equity, acceptable for conservative" -> include in report.

### 4.3 Market Data Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_mark_price` | Current mark price from Hyperliquid | `asset` |
| `get_equity` | User account equity from Hyperliquid | `walletAddress` |
| `get_candles` | OHLCV candles for ATR calculation | `asset`, `interval`, `count` |
| `get_risk_thresholds` | User risk thresholds from DB | `userId` |
| `get_graph_patterns` | Historical graph patterns from ArangoDB | `asset`, `category`, `signals` |
| `get_orderbook_depth` | Bid/ask depth from Hyperliquid | `asset`, `depth` |

All data from existing providers in `lib/data/hyperliquid.ts` and `lib/db/`.

### 4.4 Exa Web Search Tool

| Tool | Description | Parameters |
|------|-------------|------------|
| `web_search` | Search the web for recent news, sentiment, macro events | `query` |

LLM can use this to validate against real-world events. Example: "BTC news today" -> finds that Fed just announced rate hike -> adjusts confidence or adds risk flag.

### 4.5 Vibe-Trading Inspired Tools

From skills downloaded to `lib/agent/skills/`. These are new tools built from the methodology in the SKILL.md files.

| Tool | Source Skill | Description | Parameters |
|------|-------------|-------------|------------|
| `analyze_funding_regime` | perp-funding-basis | Check if funding is overheating (bullish carry, bearish sentiment, leveraged long buildup). Overheating = NO_TRADE signal. | `asset` |
| `check_liquidation_zones` | liquidation-heatmap | Check if SL/TP levels overlap with known liquidation clusters. Returns warning if entry is near a magnet zone. | `asset`, `entryPrice`, `stopLoss` |
| `assess_cascade_risk` | liquidation-heatmap | Check if multiple liquidation clusters are stacked within 5% of each other. High risk = reject entry or widen SL. | `asset` |
| `detect_oi_funding_divergence` | perp-funding-basis | Compare price action vs open interest + funding rate. Divergence = trend may reverse. | `asset` |

### 4.6 Tool Access

All 3 perspective subagents get access to ALL tools (risk engine, market data, Exa, Vibe-Trading). The LLM decides which tools to use based on its perspective:
- Conservative: likely calls `compute_atr`, `check_liquidation_zones`, `assess_cascade_risk` more.
- Aggressive: likely calls `analyze_funding_regime`, `detect_oi_funding_divergence`, `web_search` more.

The orchestrator has access to all tools as well, primarily for cross-verification during AGGREGATE.

---

## 5. Type Definitions

### 5.1 New Types (extends `lib/agent/planning/types.ts`)

```ts
// Replace current PerspectiveResult with PerspectiveReport (mirrors FactorReport from DD)
interface PerspectiveReport {
  perspective: "conservative" | "balance" | "aggressive"
  score: number | null                    // 0-100 overall score for this perspective's recommendation
  confidence: number | null               // 0-100
  side: "long" | "short" | "no_trade"     // NEW: "no_trade" option
  entry_price: number
  signals: SignalEntry[]
  dataSources: string[]                   // which tools/data sources were used
  reasoning: string                       // full LLM reasoning
  iterations: number                      // how many ReAct loops used
  conclusion: string                      // 1-2 sentence summary
  errors: string[]
  suggested_stop_loss: number
  suggested_take_profit: number
  suggested_leverage: number
  suggested_position_size_usdc: number
  risk_flags: string[]
}

// Updated aggregator output (extends existing AggregatedReasoning)
interface AggregatedReasoning {
  side: "long" | "short" | "no_trade"
  thesis: string
  reasoning: string
  confidence_score: number
  confidence_breakdown: ConfidenceBreakdown
  leverage: number
  risk_flags: string[]
  entry_price: number
  stop_loss: number
  take_profit: number
  position_size_usdc: number
  // NEW fields
  consensus_alignment: number             // 0-100: how aligned are the 3 perspectives
  contradictions: string[]
  profit_feasible: boolean                // does expected profit meet targetProfitPercent?
  no_trade_reason?: string                // if action is NO_TRADE, explain why
}

// Agent plan for orchestrator (mirrors DD AgentPlan)
interface PlanningAgentPlan {
  subagents: SubagentPlan[]
  reDeployHistory: ReDeployEntry[]
}

interface SubagentPlan {
  perspective: "conservative" | "balance" | "aggressive"
  instruction: string                     // specific instruction from orchestrator
  priority: number                        // 1-3 (1 = highest)
}

interface ReDeployEntry {
  perspective: string
  previousConfidence: number | null
  newInstruction: string
  iteration: number
}

// Consensus evaluation result
interface ConsensusResult {
  decision: "ACCEPT" | "RE-DEPLOY" | "NO_TRADE" | "FAILED"
  lowConsensusPerspectives: string[]
  contradictions: string[]
  message: string
  noTradeReason?: string
}

// Updated input (replaces PlanningPipelineInput)
interface PlanningAgentInput {
  asset: string
  userId: string
  walletAddress: string
  targetProfitPercent: number             // e.g. 100 = 100% profit target
}

// Updated TradePlan (extends lib/agent/types.ts TradePlanSchema)
// Add field:
//   action: "LONG" | "SHORT" | "NO_TRADE"      // NEW
//   consensus_alignment: number                 // NEW
//   processingTimeMs: number                    // NEW
//   iterations: number                          // NEW
```

---

## 6. ReAct Loop Implementation

### 6.1 Reuse DD SubAgent Core

The DD Agent's `runSubagent()` in `lib/agent/due-diligence/subagent.ts` is generic. Planning perspective subagents reuse it directly with:
- `maxLoops = 5`
- `factor` set to the perspective name
- Custom `llmThink` that uses planning-specific system prompt
- Custom `getSystemPrompt` that describes planning tools and perspective context

No new subagent loop implementation needed. Only new LLM prompt functions and tool registry assembly.

### 6.2 Planning Agent Orchestrator

```ts
// lib/agent/planning/agent.ts
async function runPlanningAgent(params: PlanningAgentInput): Promise<PlanningAgentOutput>

// Internal loop:
// 1. Auto-call runDDAgent(asset, userId, walletAddress)
// 2. PLAN: llmPlan({ ddReport, targetProfitPercent }) -> AgentPlan
// 3. For each iteration (max 5):
//    a. EXECUTE: Promise.all of 3 subagents via runSubagent()
//    b. AGGREGATE: llmAggregate({ reports, ddReport, targetProfitPercent })
//    c. EVALUATE Layer 1: evaluateConsensus(reports, aggregation)
//    d. If ACCEPT -> break and continue to Layer 2
//    e. If NO_TRADE -> return with action=NO_TRADE
//    f. If FAILED -> return with errors
//    g. If RE-DEPLOY -> rePlan for low-consensus perspectives, loop
// 4. Layer 2: autonomyGate(confidence, positionSize, thresholds) -> auto/approve
// 5. Build final TradePlan
```

### 6.3 Perspective Subagent (wrapper)

```ts
// lib/agent/planning/subagent.ts
// Thin wrapper that calls DD's runSubagent() with planning-specific params
async function runPerspectiveSubagent(params: {
  perspective: "conservative" | "balance" | "aggressive"
  instruction: string
  asset: string
  ddReport: DDReport
  tools: ToolRegistry
}): Promise<PerspectiveReport>
```

---

## 7. LLM Integration

### 7.1 Model Configuration

| Aspect | Perspective SubAgent (ReAct) | Orchestrator + Aggregator |
|--------|------------------------------|----------------------------|
| Model | `deepseek-v4-flash` | `deepseek-v4-pro` |
| Mode | Non-thinking (fast) | Thinking enabled |
| Temperature | 0.3 | ignored (thinking mode) |
| Response format | `json_object` | `json_object` |
| Max tokens | 4096 | 8192 |
| Reasoning effort | N/A | `high` |

Same model config as DD Agent. Flash for speed (perspective subagents make up to 5 calls each = 15 total), Pro for reasoning quality (orchestrator plan + aggregate).

### 7.2 Perspective SubAgent System Prompt

```
You are a {conservative|balance|aggressive} trading analyst specializing in Hyperliquid perpetual futures.

Your job: analyze the provided DDReport and use available tools to formulate a trade plan. You do NOT re-analyze technical indicators (the DDReport already did that). You focus on:
1. Validating the DDReport's conclusions against current market data
2. Computing risk parameters (ATR, SL/TP, position size) using available tools
3. Checking for external factors (news, sentiment, funding regime) that might invalidate the DDReport
4. Deciding whether this trade meets the user's target profit of {targetProfitPercent}%

Available tools:
{tool_descriptions}

For each tool call, return:
{ "action": "tool_call", "toolName": "...", "params": {...}, "reasoning": "..." }

When ready to return your final analysis, return:
{
  "action": "return",
  "score": <0-100>,
  "confidence": <0-100>,
  "side": "long" | "short" | "no_trade",
  "entry_price": <number>,
  "signals": [...],
  "suggested_stop_loss": <number>,
  "suggested_take_profit": <number>,
  "suggested_leverage": <number>,
  "suggested_position_size_usdc": <number>,
  "reasoning": "...",
  "conclusion": "...",
  "risk_flags": [...]
}
```

### 7.3 Orchestrator Plan Prompt

```
You are a trade planning orchestrator. You manage 3 perspective subagents (conservative, balance, aggressive).

Given a DDReport and user's target profit of {targetProfitPercent}%, decide:
1. Which perspectives to deploy (always all 3 for first iteration)
2. Specific instruction for each perspective
3. Priority order

The DDReport contains analysis of 4 factors: technical, onchain, sentiment, fundamental.

For each perspective, write instruction that tells the subagent:
- What aspects of the DDReport to focus on
- What tools to prioritize (risk calc, funding check, liquidation zones, web search)
- Whether to be skeptical or trusting of the DDReport's conclusions

Return: { "subagents": [{ "perspective": "...", "instruction": "...", "priority": number }] }
```

### 7.4 Aggregator Prompt

```
You are a trade plan aggregator. Merge 3 perspective reports into one final trade plan.

Input:
- 3 PerspectiveReports (conservative, balance, aggressive)
- DDReport
- User target profit: {targetProfitPercent}%

Tasks:
1. Determine consensus: do all 3 agree on side (long/short/no_trade)?
2. Synthesize thesis: combine the strongest points from each perspective
3. Set final parameters: entry, SL, TP, leverage, position size (prefer median across perspectives)
4. Check profit feasibility: does expected profit (based on TP - entry) meet target?
5. Flag contradictions: if perspectives disagree, note what they disagree on

If 2+ perspectives conclude "no_trade", the final action should be "no_trade".

Return: { side, thesis, reasoning, confidence_score, confidence_breakdown, leverage, risk_flags, entry_price, stop_loss, take_profit, position_size_usdc, consensus_alignment, contradictions, profit_feasible, no_trade_reason? }
```

---

## 8. Consensus Evaluation (Layer 1)

### 8.1 Decision Rules

Deterministic function `evaluateConsensus()` in `lib/agent/planning/evaluate.ts`:

| Condition | Decision | Meaning |
|-----------|----------|---------|
| All 3 perspectives same side, aggregator confidence >= 60, profit_feasible = true | ACCEPT | Plan passes quality check |
| 2/3 perspectives agree on side, aggregator confidence >= 50 | ACCEPT | Majority consensus, acceptable |
| 1-2 perspectives disagree or confidence < 50 | RE-DEPLOY | Targeted re-run for low perspectives |
| All 3 perspectives return confidence < 40 | RE-DEPLOY | All perspectives uncertain, re-plan with new instructions |
| All 3 perspectives return "no_trade" | NO_TRADE | Market not worth trading |
| Funding regime = overheated + 2+ perspectives flag it | NO_TRADE | Overheating detected |
| All 3 perspectives failed (errors or no data) | FAILED | Cannot produce any plan |
| Re-deployed 2x for same perspective, still low confidence | ACCEPT (partial) | Accept best available data |

### 8.2 Layer 2: Autonomy Gate

Same as current `autonomyGate()` in `lib/agent/planning/gate.ts`. No changes.
- If `confidence >= thresholds.confidence_threshold` AND `position_size_usdc <= thresholds.max_position_usdc` -> "auto"
- Otherwise -> "approve"

---

## 9. Error Handling

### 9.1 Tool Failure
- Retry 1x with 500ms backoff.
- Return `{ success: false, error: "..." }`.
- Subagent: continue with remaining tools, note error in PerspectiveReport.errors[].

### 9.2 LLM Failure
- Retry 1x.
- Perspective subagent fallback: return PerspectiveReport with `score: null`, `confidence: null`, whatever data was collected via tools.
- Orchestrator fallback: if all subagents failed, return FAILED.
- Aggregator fallback: if aggregation LLM fails, use deterministic merge (median values across perspectives, majority vote for side).

### 9.3 Subagent Timeout
- 60s max per perspective subagent.
- Force return at loop 5 or timeout, whichever comes first.
- Return partial PerspectiveReport with whatever data was collected.

### 9.4 DD Agent Failure
- If step 0 (auto-call DD agent) fails, planning agent returns error immediately.
- Planning cannot proceed without a DDReport.

### 9.5 NO_TRADE Cases
When to return NO_TRADE:
- ATR < 0.5% of entry price (price too flat).
- All 3 perspectives return `side: "no_trade"`.
- Funding regime detected as "overheated" + 2+ perspectives confirm it.
- User's targetProfitPercent is impossible given current volatility.
- DDReport overallScore < 30 and all perspectives confirm low conviction.

### 9.6 Error Response Format

When planning fails completely (orchestrator returns FAILED), the API responds with:

```json
{
  "error": "PLANNING_FAILED",
  "message": "All 3 perspective subagents failed to produce a valid plan.",
  "details": {
    "phase": "orchestrator" | "execute" | "aggregate" | "evaluate" | "dd",
    "reports": [],          // partial perspective reports if any
    "aggregation": null,    // partial aggregation if any
    "ddReport": null        // null if DD agent itself failed
  },
  "processingTimeMs": 1234
}
```

When a partial plan exists but failed consensus evaluation:

```json
{
  "error": "CONSENSUS_FAILED",
  "message": "Perspectives could not reach consensus after 2 re-deploy cycles.",
  "details": {
    "aggregation": { ... },           // best available aggregation
    "contradictions": ["..."],
    "lowConsensusPerspectives": ["conservative"],
    "acceptance": "FAILED"
  },
  "processingTimeMs": 5678
}
```

### 9.7 Circuit Breaker

Prevent cascading failures across multiple API calls:

| Rule | Threshold | Action |
|------|-----------|--------|
| Consecutive DD agent failures | 3 in 5 minutes | Reject planning requests for 60s, log warning |
| Consecutive LLM failures (any LLM call) | 5 in 10 minutes | Reject all planning requests for 120s, log error |
| Subagent timeout (all 3 subagents) | 2 consecutive runs | Flag asset as "unprocessable", skip re-deploy, return FAILED |
| Total planning error rate | >50% in last 10 requests | Log critical, suggest manual review |

Circuit breaker state is in-memory per process. Reset on process restart.

### 9.8 Logging Strategy

| Event | Level | Data |
|-------|-------|------|
| Planning run started | INFO | `runId`, `asset`, `userId` |
| DD agent step completed | INFO | `runId`, `ddReport.overallScore`, `durationMs` |
| Each perspective ReAct step | DEBUG | `runId`, `perspective`, `toolName`, `iteration`, `success` |
| Perspective subagent completed | INFO | `runId`, `perspective`, `score`, `confidence`, `iterationsUsed` |
| Aggregation completed | INFO | `runId`, `consensus_alignment`, `confidence_score`, `durationMs` |
| Consensus evaluation | INFO | `runId`, `decision`, `reason` |
| Re-deploy triggered | WARN | `runId`, `perspective`, `reason` |
| NO_TRADE decision | INFO | `runId`, `reason` |
| Tool failure (single) | WARN | `runId`, `toolName`, `error` |
| LLM failure (single) | ERROR | `runId`, `model`, `phase`, `errorMessage` |
| Circuit breaker tripped | ERROR | `rule`, `count`, `duration` |
| Planning completed (success) | INFO | `runId`, `action`, `durationMs` |

Use existing project logger if available. Otherwise, `console.warn`/`console.error` for WARN/ERROR, `console.log` for DEBUG (gated behind `process.env.NODE_ENV === "development"`).

---

## 10. Memory and State

### 10.1 Runtime State
- `PlanningAgentState`: in-memory JavaScript object, per-run.
- Fields: `runId`, `asset`, `status`, `perspectiveReports`, `iteration`, `errors`, `startedAt`.
- Not persisted. Volatile.

### 10.2 TradePlan Persistence
- Existing collection for trade plans. Extend if needed.
- Write after planning complete (non-blocking).
- Store full TradePlan + `ddReport` reference + `userId` + `walletAddress`.

### 10.3 Tool Result Cache
- Skip for MVP.
- If web search results are expensive, consider in-memory cache per run (same query within one run hits cache).

---

## 11. File Structure

```
lib/agent/
  types.ts                              # EXTEND: TradePlanSchema add "action"
  pipeline.ts                           # EXTEND: add planningAgentPipeline()

  planning/
    agent.ts                            # NEW: PlanningAgentMain orchestrator (Plan-Execute-Reflect)
    subagent.ts                         # NEW: perspective subagent wrapper (calls DD runSubagent)
    evaluate.ts                         # NEW: evaluateConsensus(), Layer 1 + Layer 2 logic
    llm.ts                              # REFACTOR: add think(), plan(), aggregate(), rePlan()
    prompts.ts                          # REFACTOR: add system prompts for ReAct + orchestrator + aggregator
    types.ts                            # REFACTOR: add PerspectiveReport, PlanningAgentPlan, ConsensusResult, etc.
    risk-engine.ts                      # KEEP: functions become tool execute() bodies
    gate.ts                             # KEEP: unchanged

    tools/                              # NEW: tool definitions for planning agent
      index.ts                          # buildPlanningToolRegistry()
      risk-engine.ts                    # wrap computeATR, computeSLTP, computePositionSize, capLeverage as tools
      market-data.ts                    # wrap get_mark_price, get_equity, get_candles, etc.
      web-search.ts                     # wrap Exa search as tool
      funding.ts                        # analyze_funding_regime, detect_oi_funding_divergence
      liquidation.ts                    # check_liquidation_zones, assess_cascade_risk

  tools/                                # EXISTING: DD tools (technical, onchain, sentiment, fundamental)
    types.ts                            # EXISTING: ToolDefinition, ToolRegistry, ToolResult

app/api/agent/planning/
  route.ts                              # REFACTOR: receive asset+userId+walletAddress+targetProfitPercent
                                        # auto-call DD agent -> pass to planning agent -> return TradePlan
```

---

## 12. API Route Changes

### Current

```
POST /api/agent/planning
Body: { ddReport: DDReport, userId: string, walletAddress: string }
Response: { plan: TradePlan, timing: {...} }
```

### After Refactor

```
POST /api/agent/planning
Body: {
  asset: string,                // e.g. "BTC"
  userId: string,
  walletAddress: string,
  targetProfitPercent: number,  // e.g. 100 = 100% profit target
}
Response: { plan: TradePlan, timing: {...} }

// Internally, route.ts:
// 1. ddReport = await runDDAgent({ asset, userId, walletAddress })
// 2. plan = await runPlanningAgent({ asset, userId, walletAddress, targetProfitPercent })
//    (passes ddReport internally)
// 3. return { plan, timing }
```

The `ddReport` is no longer in the request body. Planning agent now calls DD agent internally as step 0.

---

## 13. Migration Plan

### Phase 1: Types and Tools (no behavior change)
1. Add new types to `lib/agent/planning/types.ts` (PerspectiveReport, ConsensusResult, etc.)
2. Extend TradePlanSchema in `lib/agent/types.ts` with `action` field.
3. Build planning tool definitions in `lib/agent/planning/tools/`:
   - Wrap `risk-engine.ts` functions as tools.
   - Wrap market data fetchers as tools.
   - Build Vibe-Trading tools (funding, liquidation).
   - Build Exa web search tool.
4. Unit test all tools.

### Phase 2: SubAgent ReAct
1. Create `lib/agent/planning/subagent.ts` - thin wrapper around DD's `runSubagent()`.
2. Write perspective-specific system prompts in `prompts.ts`.
3. Write `llm.ts` think() function for perspective subagents.
4. Integration test: single perspective subagent with mock tools.

### Phase 3: Orchestrator
1. Create `lib/agent/planning/agent.ts` - Plan-Execute-Reflect loop.
2. Create `lib/agent/planning/evaluate.ts` - Layer 1 consensus + Layer 2 gate.
3. Write plan(), aggregate(), rePlan() in `llm.ts`.
4. Integration test: full orchestrator with mock subagents.

### Phase 4: Cutover
1. Refactor `app/api/agent/planning/route.ts`:
   - Accept new body format (asset, userId, walletAddress, targetProfitPercent).
   - Auto-call DD agent internally.
   - Call new `runPlanningAgent()`.
2. E2E test with real asset.
3. Remove old `runPlanningPipeline()` after verification.

---

## 14. Resolved Questions

1. **Multi-perspective pattern:** Keep 3 perspectives (conservative, balance, aggressive) but upgrade each to a ReAct subagent with tools. Orchestrator uses Plan-Execute-Reflect. Pattern mirrors DD Agent architecture.

2. **Risk engine:** Keep deterministic (pure math, no LLM). Convert risk engine functions into granular tools (`compute_atr`, `compute_sltp`, `compute_position_size`, `cap_leverage`) so the LLM can call them iteratively and do "what-if" analysis.

3. **Tools per subagent:** Risk engine tools + market data tools + Exa web search + Vibe-Trading tools (funding regime, liquidation zones). All 3 subagents get the same toolset. The LLM decides which tools to use based on its perspective.

4. **Subagent iterations:** 5 ReAct iterations per subagent (vs DD's 3). More tools = more exploration allowed.

5. **Aggregator:** LLM-based (v4-pro, thinking mode). Merges 3 PerspectiveReports into one final trade plan.

6. **Evaluation:** 2 layers. Layer 1 (consensus) checks plan quality: do perspectives agree, is confidence high, is profit feasible? Layer 2 (autonomy gate) decides auto vs approve. Both are deterministic.

7. **NO_TRADE:** Planning agent can return `action: "NO_TRADE"` when market conditions are poor (flat ATR, overheated funding, all perspectives agree no opportunity).

8. **Input format:** Planning API no longer receives `ddReport`. Body is `{ asset, userId, walletAddress, targetProfitPercent }`. Agent auto-calls DD agent as step 0.

9. **targetProfitPercent:** Integer percentage (e.g. 100 = 100%, not 0.01). Used by aggregator to validate whether the plan's expected profit meets user expectations.

---

## 15. Dead Code Removal

Summary of what gets deleted and when during migration.

### 15.1 Removal Schedule

| File | Function/Export | Phase of Removal | Reason |
|------|----------------|-------------------|--------|
| `planning/pipeline.ts` | `runPlanningPipeline()` | Phase 4 | Replaced by `runPlanningAgent()` in `agent.ts` |
| `planning/pipeline.ts` | Step 1 market data fetch (mark price, candles, etc.) | Phase 2 | Replaced by tools: `get_mark_price`, `get_candles`, etc. Subagent fetches via tools instead of pre-fetch. |
| `planning/pipeline.ts` | Step 2 `generatePerspective()` calls | Phase 2 | Replaced by perspective subagents with ReAct loop |
| `planning/pipeline.ts` | Step 3 `aggregatePerspectives()` call | Phase 3 | Replaced by orchestrator's LLM aggregator in `llm.ts` |
| `planning/pipeline.ts` | Step 4 `computeATR`/`computeSLTP`/`computePositionSize`/`capLeverage` calls | Phase 2 | Called directly by subagent via risk engine tools, no longer in pipeline |
| `planning/pipeline.ts` | Step 5 `autonomyGate()` call | Phase 3 | Moved to `evaluate.ts` Layer 2 |
| `planning/llm.ts` | `generatePerspective()` | Phase 2 | Replaced by ReAct `think()` per subagent iteration |
| `planning/llm.ts` | `aggregatePerspectives()` | Phase 3 | Replaced by orchestrator aggregator LLM call |
| `planning/prompts.ts` | `CONSERVATIVE_SYSTEM_PROMPT` | Phase 2 | Replaced by ReAct system prompt (Section 7.2) |
| `planning/prompts.ts` | `BALANCE_SYSTEM_PROMPT` | Phase 2 | Replaced by ReAct system prompt (Section 7.2) |
| `planning/prompts.ts` | `AGGRESSIVE_SYSTEM_PROMPT` | Phase 2 | Replaced by ReAct system prompt (Section 7.2) |
| `planning/prompts.ts` | `AGGREGATOR_SYSTEM_PROMPT` / `AGGREGATOR_USER_PROMPT` | Phase 3 | Replaced by orchestrator aggregate prompt (Section 7.4) |
| `planning/types.ts` | `PerspectiveResult` | Phase 3 | Replaced by `PerspectiveReport` |
| `planning/types.ts` | `PlanningPipelineInput` | Phase 3 | Replaced by `PlanningAgentInput` |
| `planning/pipeline.ts` | Entire file (after all above removed) | End of Phase 4 | Empty — delete file |

### 15.2 What Stays (No Delete)

| File | What Stays | Reason |
|------|-----------|--------|
| `planning/risk-engine.ts` | `computeATR`, `computeSLTP`, `computePositionSize`, `capLeverage`, `computeEntryPrice` | Functions become tool `execute()` bodies — no logic change |
| `planning/gate.ts` | `autonomyGate()` | Same logic, called from `evaluate.ts` Layer 2 |
| `planning/llm.ts` | File stays | Refactored: old functions removed, new functions added (`think`, `plan`, `aggregate`, `rePlan`) |
| `planning/prompts.ts` | File stays | Refactored: old prompts removed, new prompts added (ReAct system, orchestrator plan, aggregator, rePlan) |
| `planning/types.ts` | `AggregatedReasoning`, `ConfidenceBreakdown`, `SignalEntry`, `RiskFlag` | Stay, some extended with new fields |

### 15.3 Verification After Removal

After each phase, run to confirm nothing is broken:

```powershell
# Check no dead imports pointing to deleted exports
rg -r "" "from.*planning.*pipeline" lib\ app\ --include "*.ts" --include "*.tsx"

# TypeScript check
npx tsc --noEmit

# Existing tests still pass
npm test
```

### 15.4 Deletion Order

1. **Phase 2:** Remove market data fetch from pipeline, `generatePerspective()`, old perspective prompts. Pipeline now calls new agent instead.
2. **Phase 3:** Remove `aggregatePerspectives()`, old aggregator prompts, `PerspectiveResult`, `PlanningPipelineInput`. Pipeline shell only.
3. **End of Phase 4:** Delete entire `pipeline.ts`. Clean up any remaining dead imports in `route.ts`.

---

## 16. Open Questions

1. **Exa search implementation:** Exa MCP server needs API key. Is the user's Exa key already configured in the project, or does it need to be set up? The tool can be built but won't work without a key.

2. **Liquidation data source:** Vibe-Trading's `liquidation-heatmap` skill assumes access to exchange liquidation data APIs (OKX, Binance). Hyperliquid's public API does have liquidation data, but format/availability should be verified before implementing `check_liquidation_zones` and `assess_cascade_risk`.

3. **Funding rate data:** Hyperliquid API returns current funding rate via the info endpoint. The `analyze_funding_regime` tool needs to check: does HL also provide predicted funding rate (next payment estimate)? Or only current rate?

4. **User equity fetch:** The `get_equity` tool calls Hyperliquid's user-specific endpoint which requires authentication. Should the tool execute with the user's wallet (implying the API route has access to user credentials), or does the orchestrator pre-fetch equity and pass it as context?

5. **targetProfitPercent validation:** Should there be a maximum cap (e.g. 1000%) to prevent unrealistic targets? Or trust the LLM to flag "impossible" targets on its own?

6. **Existing consumers of planning API:** Should the old endpoint format (`{ ddReport, userId, walletAddress }`) still be accepted for backward compatibility, or is a breaking change acceptable (consumers must update to new format)?

7. **DD Agent dependency:** If the auto-call to DD agent in step 0 takes 30-60 seconds, the planning API total latency could be 90-120 seconds. Is this acceptable? Or should DD and planning be decoupled (user runs DD first, then planning)?

8. **Subagent dedup:** If the orchestrator re-deploys a perspective with a new instruction, should the new result replace the old one (like DD does), or should both results be kept for the aggregator to compare?

9. **Testing with Vibe-Trading tools:** The liquidation and funding tools depend on live Hyperliquid API data. Should integration tests use mock data, or should there be a way to record/replay API responses?
