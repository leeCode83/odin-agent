# Spec: Execution Agent

> **Status:** Approved
> **Ref:** `docs/odin-spec.md` §4.3, `docs/planning-agent-spec.md` §5 (TradePlan schema)
> **Input from:** Planning Agent (`TradePlan`)

---

## 1. Objective

Build the Execution Agent — the third and final agent in Odin's 3-agent pipeline. Execution Agent takes a `TradePlan` (produced by Planning Agent), places an entry order + OCO TP/SL trigger orders on Hyperliquid testnet via `@nktkas/hyperliquid` SDK, monitors fill status via WebSocket, and reports execution result. Supports one-time agent wallet setup and emergency cancel-all.

**Success criteria:**
- Given a valid `TradePlan` + `walletAddress`, place entry + OCO TP/SL within 5 seconds
- Monitor fill via WebSocket `orderUpdates`; return fill status (filled / partially filled / cancelled) in API response + subsequent polling endpoint
- Agent wallet: auto-generated private key, approved once via `POST /api/agent/execution/init`, key stored in `.env`
- OCO TP/SL: one triggers, other auto-cancels (Hyperliquid `grouping: "normalTpsl"`)
- Emergency cancel: `POST /api/agent/execution/cancel` — cancel ALL open orders for the agent wallet
- **Record trade execution to ArangoDB graph memory** — decision node, signal nodes (if ddReport provided), edges
- **Record trade outcome on close** — upsert outcome node + edge via `POST /api/agent/execution/outcome`
- No position management (hedging allowed — place order regardless of existing positions)

---

## 2. Architecture Overview

```
┌──────────────┐     TradePlan      ┌─────────────────────────┐
│   Planning   │ ──────────────────►│    Execution            │
│   Agent      │     (opt. DD)      │    Agent                │
└──────────────┘                    │                         │
                                    │  1. Validate            │
                                    │  2. Build orders        │
                                    │  3. Sign & place        │
                                    │  4. Monitor fill        │
                                    │  5. Record to graph     │
                                    │  6. Return result       │
                                    └──────┬──────────────────┘
                                           │
                              ┌────────────┴────────────┐
                              │  Hyperliquid Testnet    │
                              │  (Exchange API)         │
                              │  agent wallet signs     │
                              │  vaultAddress = master  │
                              └─────────────────────────┘

                              ┌─────────────────────────────────┐
                              │  ArangoDB Graph Memory          │
                              │  • DecisionNode (trade plan)    │
                              │  • SignalNode[] (from DD)       │
                              │  • OutcomeNode (on close)       │
                              │  • Edges: TRIGGERED_BY,         │
                              │    ANALYZED, RESULTED_IN        │
                              └─────────────────────────────────┘
```

### 2.1 Agent Wallet Model

User (master wallet) approves an agent wallet once. Agent wallet has its own private key, can ONLY trade (place/cancel/modify orders, set leverage), cannot withdraw or approve other agents.

```
INIT (one-time):
  POST /api/agent/execution/init
    → generatePrivateKey() → agent wallet
    → masterClient.approveAgent({ agentAddress, agentName: "odin" })
    → save AGENT_PRIVATE_KEY to .env

TRADE (every pipeline run):
  POST /api/agent/execution
    → ExchangeClient(agent wallet signer)
    → build entry order + OCO TP/SL
    → place with vaultAddress = master.address
    → monitor fill via WebSocket
    → record decision + signals to ArangoDB (optional: ddReport for signals)
```

---

## 3. Data Flow

```
Trigger (API route)
      │
      ▼
  validateInput(TradePlan) ──► Zod parse, check side/asset/entry valid
      │
      ▼
  buildOrders(TradePlan) ──► limit entry order + 2 trigger TP/SL orders
      │                         • entry: limit IoC at mark price
      │                         • TP: trigger order at take_profit, reduceOnly
      │                         • SL: trigger order at stop_loss, reduceOnly
      │                         • grouping: "normalTpsl" (OCO on TP+SL)
      │
      ▼
  placeOrders(exchangeClient, orders, vaultAddress)
      │                         • set leverage first (updateLeverage)
      │                         • submit orders via exchangeClient.order()
      │
      ▼
  subscribeFill(wsClient, orderIds, timeout) ──► WebSocket orderUpdates
      │                         • listen for "fill" or "canceled" status
      │                         • wait up to 15s for fill confirmation
      │                         • fallback: poll info API if WS unavailable
      │
      ▼
  recordGraphMemory(tradePlan, signals?) ──► ArangoDB insert
      │                         • DecisionNode from trade plan
      │                         • SignalNode[] from ddReport (if provided)
      │                         • AssetNode if not exists
      │                         • Edges: TRIGGERED_BY, ANALYZED
      │                         • Fire-and-forget — failure does not fail pipeline
      │
      ▼
  return ExecutionResult { orderId, oid, status, fillAmount, …, decisionKey }
```

Key constraints:
- Entry order uses limit IoC (`tif: "Ioc"`) at entry_price — simulated market order
- TP/SL are trigger orders with `reduceOnly: true`
- TP/SL grouped with `grouping: "normalTpsl"` (OCO — one fills, other cancels)
- Vault address = master wallet address (orders placed on behalf of master using agent wallet signature)
- No LLM calls in Execution Agent — purely deterministic code
- Max latency: <5s for order placement, <15s for fill monitoring
- Graph memory recording is fire-and-forget — pipeline succeeds regardless of DB write failure
- ddReport is OPTIONAL — when absent, only decision node is recorded (no signals/edges)

---

## 4. Hyperliquid SDK Usage

### 4.1 ExchangeClient (via `@nktkas/hyperliquid`)

```ts
import {
  HttpTransport,
  ExchangeClient,
  SubscriptionClient,
  formatPrice,
  formatSize,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

const transport = new HttpTransport({ isTestnet: true });
const account = privateKeyToAccount(agentPrivateKey as `0x${string}`);
const exchangeClient = new ExchangeClient({ transport, wallet: account });
```

### 4.2 Order Types Used

| Order Type | TIF | Purpose | Fields |
|---|---|---|---|
| Limit (entry) | `Ioc` | Simulated market — fills immediately or cancels | `limitPx: price, sz: size, isTrigger: false, tif: "Ioc"` |
| Trigger (TP) | `Gtc` | Take profit when price reached | `triggerPx: tp, isTrigger: true, triggerCondition: ">=" long / "<=" short, reduceOnly: true` |
| Trigger (SL) | `Gtc` | Stop loss when price reached | `triggerPx: sl, isTrigger: true, triggerCondition: "<=" long / ">=" short, reduceOnly: true` |

### 4.3 Grouping (OCO)

TP and SL orders assigned the same `grouping` key. One fills → other auto-cancels.

```ts
const grouping = "normalTpsl";
// Both TP and SL get the same grouping key
```

### 4.4 Leverage

Set leverage BEFORE placing orders:

```ts
await exchangeClient.updateLeverage({
  name: "BTC",
  isCross: true,
  leverage: tradePlan.leverage,
  vaultAddress: masterAddress,
});
```

### 4.5 Asset Format

Hyperliquid uses `name` (e.g. "BTC"), not ticker. TradePlan.asset is already "BTC" format — no conversion needed.

### 4.6 Size/Price Formatting

Use SDK utilities:
- `formatPrice(price, szDecimals)` — converts to tick size
- `formatSize(size, szDecimals)` — converts to lot size

---

## 5. Endpoints

### 5.1 `POST /api/agent/execution`

Place entry order + OCO TP/SL from TradePlan.

**Request:**
```json
{
  "tradePlan": {
    "asset": "BTC",
    "side": "long",
    "entry_price": 65230.5,
    "position_size_usdc": 50.0,
    "position_size_contracts": 0.000767,
    "stop_loss": 64230.5,
    "take_profit": 68230.5,
    "leverage": 3,
    "confidence_score": 72,
    "confidence_breakdown": { "factor_alignment": 75, "historical_match": 60, "signal_strength": 80 },
    "thesis": "...",
    "reasoning": "...",
    "autonomy_decision": "auto",
    "risk_flags": [],
    "graph_patterns_used": [],
    "timestamp": "2026-07-20T10:00:00Z"
  },
  "walletAddress": "0xabc...",
  "userId": "user-1",
  "ddReport": { /* optional — full DDReport for signal graph recording */ }
}
```
**Response (200):**
```json
{
  "tradePlan": { /* validated TradePlan */ },
  "execution": {
    "status": "placed",
    "orders": [
      { "type": "entry", "oid": 12345, "status": "open" },
      { "type": "take_profit", "oid": 12346, "status": "open" },
      { "type": "stop_loss", "oid": 12347, "status": "open" }
    ],
    "groupId": "normalTpsl",
    "timestamp": "2026-07-20T10:00:05Z",
    "fillStatus": "pending",
    "fillAmount": null,
    "fillPrice": null,
    "decisionKey": "decisions/abc123"
  },
  "timing": {
    "buildMs": 1,
    "placeMs": 200,
    "graphMs": 50,
    "totalMs": 251
  }
}
```

**Error cases:**
| Scenario | Status | Response |
|---|---|---|
| Missing tradePlan, walletAddress, or userId | 400 | `{ error: "tradePlan, walletAddress, and userId required" }` |
| Invalid TradePlan (Zod) | 400 | `{ error: "Invalid tradePlan", detail: [...] }` |
| TradePlan requires approval | 400 | `{ error: "TradePlan requires manual approval — cannot auto-execute" }` |
| No agent wallet configured | 503 | `{ error: "Agent wallet not initialized. Call /api/agent/execution/init first" }` |
| Order placement failed (HL error) | 502 | `{ error: "HL exchange error", detail: "..." }` |
| Leverage update failed | 502 | `{ error: "HL exchange error (leverage)", detail: "..." }` |

### 5.2 `POST /api/agent/execution/init`

One-time agent wallet setup. Generates agent private key, approves via master wallet, saves to env.

**Request:**
```json
{
  "agentName": "odin"
}
```

**Response (200):**
```json
{
  "agentAddress": "0xdef...",
  "agentName": "odin",
  "approved": true,
  "message": "Agent wallet generated and approved. AGENT_PRIVATE_KEY saved to .env."
}
```

**Error cases:**
| Scenario | Status | Response |
|---|---|---|
| Missing MASTER_PRIVATE_KEY in env | 400 | `{ error: "MASTER_PRIVATE_KEY not set in .env" }` |
| Master wallet has insufficient funds | 400 | `{ error: "Master wallet cannot pay approval gas" }` |
| Already initialized | 200 | `{ agentAddress: "...", approved: true, message: "Already initialized" }` |

**Implementation note:** Cannot programmatically write to `.env` file safely in production. For MVP:
1. Generate key → return agent private key in init response
2. User manually copies to `.env` as `AGENT_PRIVATE_KEY`
3. OR: write to `.env.local` programmatically (MVP shortcut)

### 5.3 `POST /api/agent/execution/cancel`

Emergency cancel — cancels ALL open orders for the agent wallet.

**Request:** (no body required — uses agent wallet from env)

**Response (200):**
```json
{
  "cancelled": 3,
  "message": "All orders cancelled"
}
```

**Error cases:**
| Scenario | Status | Response |
|---|---|---|
| No agent wallet | 503 | `{ error: "Agent wallet not initialized" }` |
| HL cancel failed | 502 | `{ error: "HL exchange error", detail: "..." }` |

### 5.4 `GET /api/agent/execution/status?oid=12345`

Poll fill status for a specific order. Fallback when WebSocket is unavailable.

**Response (200):**
```json
{
  "oid": 12345,
  "status": "filled",
  "fillAmount": "0.000767",
  "fillPrice": "65230.5"
}
```

### 5.5 `POST /api/agent/execution/outcome`

Record trade outcome after close (TP hit / SL hit / manual cancel). Upserts `OutcomeNode` + `RESULTED_IN` edge in graph.

**Request:**
```json
{
  "decisionKey": "decisions/abc123",
  "result": "profit",
  "pnlUsdc": 12.5,
  "pnlPercent": 2.1,
  "exitPrice": 65400,
  "exitReason": "take_profit_hit"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| decisionKey | string | yes | Key of the decision node returned by execution |
| result | enum | yes | `profit` / `loss` / `breakeven` / `cancelled` |
| pnlUsdc | number | no | Realized P&L in USDC |
| pnlPercent | number | no | Realized P&L as percentage |
| exitPrice | number | no | Price at which position was closed |
| exitReason | string | no | `take_profit_hit` / `stop_loss_hit` / `manual_cancel` |

**Response (200):**
```json
{
  "recorded": true,
  "decisionKey": "decisions/abc123",
  "outcomeKey": "outcomes/def456"
}
```

**Error cases:**
| Scenario | Status | Response |
|---|---|---|
| Missing decisionKey or result | 400 | `{ error: "decisionKey and result required" }` |
| Invalid result value | 400 | `{ error: "Invalid result. Must be profit/loss/breakeven/cancelled" }` |
| DB write failed | 500 | `{ error: "Failed to record outcome", detail: "..." }` |

---



## 6. File & Module Structure

```
lib/agent/execution/
  types.ts              # INTERNAL: ExecutionInput, ExecutionOutput, OrderBuildResult
  orders.ts             # buildOrders(tradePlan, slotDecimals) → OrderRequest[]
                        #   builds limit entry + OCO TP/SL with grouping
  client.ts             # getExchangeClient(agentPrivateKey) → ExchangeClient
                        #   initAgentWallet(masterPk, agentName) → { agentAddress, agentPk }
                        #   getAgentSigner(agentPk) → account
                        #   all HL ExchangeClient creation in one place
  pipeline.ts           # runExecutionPipeline(input)
                        #   validates tradePlan, builds orders, places, monitors fill,
                        #   records to graph memory
  ws-monitor.ts         # subscribeFill(exchangeClient, orderIds, timeout) → fill result
                        #   WebSocket SubscriptionClient for orderUpdates
                        #   fallback: poll order status via infoClient if WS fails
                        # Graph memory write functions live in lib/db/graph-memory.ts
                        #   (same file as existing queryGraphPatterns read):
                        #   recordDecision(doc), recordSignals(signals, userId),
                        #   recordGraphMemory(params), recordOutcome(decisionKey, outcome)

app/api/agent/execution/
  route.ts              # POST /api/agent/execution
  init/route.ts         # POST /api/agent/execution/init
  cancel/route.ts       # POST /api/agent/execution/cancel
  outcome/route.ts      # POST /api/agent/execution/outcome
  status/route.ts       # GET  /api/agent/execution/status?oid=...
```

---

## 7. TypeScript Interfaces

### 7.1 Execution-Internal Types (`lib/agent/execution/types.ts`)

```ts
import type { TradePlan } from "@/lib/agent/types";

export interface OrderBuildResult {
  entry: {
    oid?: number;
    type: "entry";
    size: string;     // formatted contracts
    price: string;    // formatted entry price
    tif: "Ioc";
    side: "long" | "short";
  };
  takeProfit: {
    oid?: number;
    type: "take_profit";
    triggerPrice: string;
    size: string;
    groupId: string;
  };
  stopLoss: {
    oid?: number;
    type: "stop_loss";
    triggerPrice: string;
    size: string;
    groupId: string;
  };
}

export interface ExecutionResult {
  status: "placed" | "filled" | "partial" | "failed" | "cancelled";
  orders: Array<{
    type: "entry" | "take_profit" | "stop_loss";
    oid: number;
    status: "open" | "filled" | "cancelled" | "rejected";
  }>;
  groupId: string;
  fillStatus: "pending" | "filled" | "partial" | "none";
  fillAmount: string | null;
  fillPrice: string | null;
  timestamp: string;
  decisionKey?: string;     // set after graph recording
}

export interface ExecutionPipelineInput {
  tradePlan: TradePlan;
  walletAddress: string;      // master wallet address (for vaultAddress)
  userId: string;
  ddReport?: DDReport;       // optional — signals recorded to graph when provided
}

export interface ExecutionPipelineOutput {
  execution: ExecutionResult;
  timing: {
    buildMs: number;
    placeMs: number;
    graphMs: number;
    totalMs: number;
  };
}

export interface AgentInitResult {
  agentAddress: string;
  agentPrivateKey: string;
  approved: boolean;
}

export interface OutcomeInput {
  decisionKey: string;
  result: "profit" | "loss" | "breakeven" | "cancelled";
  pnlUsdc?: number;
  pnlPercent?: number;
  exitPrice?: number;
  exitReason?: string;
}
```

---

## 8. Pipeline Orchestration

### 8.1 `runExecutionPipeline(input: ExecutionPipelineInput): Promise<ExecutionPipelineOutput>`

```ts
// lib/agent/execution/pipeline.ts

import { TradePlanSchema } from "@/lib/agent/types";
import { getAgentSigner, getExchangeClient } from "./client";
import { buildOrders } from "./orders";
import { subscribeFill } from "./ws-monitor";
import { recordGraphMemory } from "@/lib/db/graph-memory";
import type { ExecutionPipelineInput, ExecutionPipelineOutput, ExecutionResult } from "./types";

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

export async function runExecutionPipeline(
  input: ExecutionPipelineInput
): Promise<ExecutionPipelineOutput> {
  const t0 = Date.now();
  const { tradePlan, walletAddress, userId, ddReport } = input;

  const validated = TradePlanSchema.parse(tradePlan);
  if (validated.autonomy_decision === "approve") {
    throw new ExecutionError("TradePlan requires manual approval — cannot auto-execute");
  }

  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) {
    throw new ExecutionError(
      "Agent wallet not initialized. Call POST /api/agent/execution/init first"
    );
  }

  const buildStart = Date.now();
  const orders = buildOrders(validated);
  const buildMs = Date.now() - buildStart;

  const placeStart = Date.now();
  const account = getAgentSigner(agentPk);
  const client = getExchangeClient(account);
  const vaultAddress = walletAddress as `0x${string}`;

  // Set leverage
  await client.updateLeverage({
    name: validated.asset,
    isCross: true,
    leverage: validated.leverage,
    vaultAddress,
  });

  // Place entry + OCO TP/SL
  const result = await client.order({
    orders: [orders.entry, orders.takeProfit, orders.stopLoss],
    grouping: "na",     // grouping handled at order level via groupId
    vaultAddress,
  });
  const placeMs = Date.now() - placeStart;

  const orderInfos = result.response?.data?.statuses ?? [];

  const execution: ExecutionResult = {
    status: "placed",
    orders: [
      { type: "entry", oid: orderInfos[0]?.oid ?? 0, status: "open" },
      { type: "take_profit", oid: orderInfos[1]?.oid ?? 0, status: "open" },
      { type: "stop_loss", oid: orderInfos[2]?.oid ?? 0, status: "open" },
    ],
    groupId: orders.takeProfit.groupId,
    fillStatus: "pending",
    fillAmount: null,
    fillPrice: null,
    timestamp: new Date().toISOString(),
  };

  // 5. Record to graph memory (fire-and-forget)
  const graphStart = Date.now();
  try {
    const signals = ddReport
      ? Object.entries(ddReport.sections).flatMap(([factor, section]) =>
          section.signals.map((signal) => ({
            factor,
            signalType: signal,
            description: section.summary ?? "",
            strength: section.score ?? 50,
          }))
        )
      : [];

    const decisionKey = await recordGraphMemory({
      userId,
      asset: validated.asset,
      tradePlan: validated,
      signals,
    });
    execution.decisionKey = decisionKey;
  } catch (err) {
    console.error("Graph memory recording failed (non-fatal):", err);
  }
  const graphMs = Date.now() - graphStart;

  return {
    execution,
    timing: { buildMs, placeMs, graphMs, totalMs: Date.now() - t0 },
  };
}
```

### 8.2 Order Builder (`lib/agent/execution/orders.ts`)

```ts
export function buildOrders(tradePlan: TradePlan): {
  entry: object;
  takeProfit: object;
  stopLoss: object;
} {
  const grouping = "normalTpsl";

  const isLong = tradePlan.side === "long";
  const entrySide = isLong ? "B" : "A";
  const tpCondition = isLong ? { triggerCondition: ">=" as const } : { triggerCondition: "<=" as const };
  const slCondition = isLong ? { triggerCondition: "<=" as const } : { triggerCondition: ">=" as const };

  const entry = {
    a: tradePlan.asset,
    b: entrySide,
    p: String(tradePlan.entry_price),
    s: String(tradePlan.position_size_contracts),
    r: false,
    t: { limit: { tif: "Ioc" } },
  };

  const takeProfit = {
    a: tradePlan.asset,
    b: entrySide === "B" ? "A" : "B",  // opposite side to close
    p: String(tradePlan.take_profit),
    s: String(tradePlan.position_size_contracts),
    r: true,                            // reduceOnly
    t: { trigger: { isTrigger: true, triggerPx: String(tradePlan.take_profit), ...tpCondition } },
    grouping,
  };

  const stopLoss = {
    a: tradePlan.asset,
    b: entrySide === "B" ? "A" : "B",
    p: String(tradePlan.stop_loss),
    s: String(tradePlan.position_size_contracts),
    r: true,
    t: { trigger: { isTrigger: true, triggerPx: String(tradePlan.stop_loss), ...slCondition } },
    grouping,
  };

  return { entry, takeProfit, stopLoss };
}
```

Note: Use the SDK's typed builder `orderRequest` / `orderWiresToOrderAction` where possible. The raw wire format above may need adjustment based on SDK v0.33.2 API.

### 8.3 Agent Wallet Client (`lib/agent/execution/client.ts`)

```ts
import { HttpTransport, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Account } from "viem";

let isTestnet = process.env.HYPERLIQUID_TESTNET !== "false";

export function getAgentSigner(privateKey: string): Account {
  return privateKeyToAccount(privateKey as `0x${string}`);
}

export function getExchangeClient(signer: Account): ExchangeClient {
  const transport = new HttpTransport({ isTestnet });
  return new ExchangeClient({ transport, wallet: signer });
}

export function getMasterSigner(): Account {
  const masterPk = process.env.MASTER_PRIVATE_KEY;
  if (!masterPk) throw new Error("MASTER_PRIVATE_KEY not set");
  return privateKeyToAccount(masterPk as `0x${string}`);
}

export function getMasterClient(): ExchangeClient {
  return getExchangeClient(getMasterSigner());
}

export function generateAgentWallet(): { address: string; privateKey: string } {
  const pk = generatePrivateKey();
  return { address: privateKeyToAccount(pk).address, privateKey: pk };
}

export async function approveAgent(
  agentAddress: `0x${string}`,
  agentName: string
): Promise<void> {
  const masterClient = getMasterClient();
  await masterClient.approveAgent({ agentAddress, agentName });
}
```

### 8.4 WebSocket Fill Monitor (`lib/agent/execution/ws-monitor.ts`)

```ts
import { SubscriptionClient } from "@nktkas/hyperliquid";
import type { InfoClient } from "@nktkas/hyperliquid";

export interface FillResult {
  status: "filled" | "partial" | "none";
  fillAmount?: string;
  fillPrice?: string;
  oid: number;
}

export function subscribeFill(
  orderIds: number[],
  timeoutMs: number = 15_000,
  infoClient?: InfoClient   // fallback polling
): Promise<FillResult[]> {
  const isTestnet = process.env.HYPERLIQUID_TESTNET !== "false";
  const wsUrl = isTestnet
    ? "wss://api.hyperliquid-testnet.xyz/ws"
    : "wss://api.hyperliquid.xyz/ws";

  return new Promise((resolve, reject) => {
    const ws = new SubscriptionClient({ url: wsUrl });
    const results: FillResult[] = [];

    const timer = setTimeout(() => {
      // WebSocket timeout — fall back to polling or return pending
      ws.unsubscribeAll();
      ws.close();
      resolve(results.length > 0 ? results : orderIds.map(oid => ({ status: "none", oid })));
    }, timeoutMs);

    ws.on("error", (err) => {
      clearTimeout(timer);
      ws.close();
      // fallback: poll via infoClient if available
      reject(err);
    });

    ws.on("orderUpdates", (update) => {
      for (const oid of orderIds) {
        if (update.oid === oid) {
          if (update.status === "filled" || update.status === "canceled") {
            results.push({
              status: update.status === "filled" ? "filled" : "none",
              fillAmount: update.sz,
              fillPrice: update.limitPx,
              oid,
            });
          }
        }
      }

      if (results.length >= orderIds.length) {
        clearTimeout(timer);
        ws.unsubscribeAll();
        ws.close();
        resolve(results);
      }
    });
  });
}
```

---

## 8.5 Graph Memory Recording (`lib/db/graph-memory.ts` — write additions)

Add to the existing read-only file. Four new exported functions:

### `recordDecision(doc: Omit<DecisionNode, '_key'>): Promise<string>`

Insert a `DecisionNode` into the `decisions` collection. Returns the `_key`.

### `recordSignals(signals: SignalInput[], userId: string): Promise<string[]>`

Upsert `SignalNode` docs into `signals` collection (dedup by `factor + signalType`). Returns array of `_key` values.

### `recordGraphMemory(params: { userId, asset, tradePlan, signals }): Promise<string>`

Orchestrator — inserts decision node + signal nodes + asset node (if new) + edges (TRIGGERED_BY, ANALYZED). Returns `_key` of the decision node.

```ts
export async function recordGraphMemory(params: {
  userId: string;
  asset: string;
  tradePlan: TradePlan;
  signals: Array<{ factor: string; signalType: string; description: string; strength: number }>;
}): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("ArangoDB not available");

  // 1. Upsert asset node
  await db.collection("assets").save({ _key: params.asset, name: params.asset, category: "trade" }, { overwriteMode: "ignore" });

  // 2. Insert decision node
  const decisionKey = await recordDecision({
    userId: params.userId,
    asset: params.asset,
    category: "trade",
    decision: params.tradePlan.side === "long" ? "buy" : "sell",
    side: params.tradePlan.side,
    confidence: params.tradePlan.confidence_score,
    tradePlan: params.tradePlan,
    autonomyDecision: params.tradePlan.autonomy_decision,
    timestamp: new Date().toISOString(),
  });

  // 3. Insert signal nodes + edges
  if (params.signals.length > 0) {
    const signalKeys = await recordSignals(params.signals, params.userId);
    const edgeCol = db.collection("decision_triggered_by");
    for (const sigKey of signalKeys) {
      await edgeCol.save({
        _from: `decisions/${decisionKey}`,
        _to: `signals/${sigKey}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 4. Edge: decision → analyzed → asset
  await db.collection("decision_analyzed").save({
    _from: `decisions/${decisionKey}`,
    _to: `assets/${params.asset}`,
    timestamp: new Date().toISOString(),
  });

  return decisionKey;
}
```

### `recordOutcome(decisionKey: string, outcome: OutcomeInput): Promise<string>`

Insert `OutcomeNode` into `outcomes` collection + create `decision_resulted_in` edge. Returns the outcome `_key`.

```ts
export async function recordOutcome(
  decisionKey: string,
  outcome: OutcomeInput
): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("ArangoDB not available");

  const outcomeDoc = await db.collection("outcomes").save({
    result: outcome.result,
    pnlUsdc: outcome.pnlUsdc,
    pnlPercent: outcome.pnlPercent,
    exitPrice: outcome.exitPrice,
    exitReason: outcome.exitReason,
    timestamp: new Date().toISOString(),
  });

  await db.collection("decision_resulted_in").save({
    _from: `decisions/${decisionKey}`,
    _to: `outcomes/${outcomeDoc._key}`,
    timestamp: new Date().toISOString(),
  });

  return outcomeDoc._key;
}
```

---

## 9. Error Handling & Resilience

| Source Failure | Handling |
|---|---|
| AGENT_PRIVATE_KEY missing | Return 503 — must call init first |
| MASTER_PRIVATE_KEY missing (init) | Return 400 — tell user to set .env |
| HL exchange API down | Retry 2× with 1s/2s backoff. All fail → return 502 |
| Leverage update fails | Return 502 — cannot place order safely |
| Entry order fails, TP/SL placed | Not possible — order placement is atomic (single `client.order()` call) |
| WebSocket unavailable | Fallback: poll order status via `GET /status?oid=` every 2s for 15s |
| Partial fill (entry not fully filled) | Report partial — Odin does not cancel unfilled remainder (IoC handles this) |
| TP/SL fill while monitoring | WebSocket delivers fill event; status endpoint returns filled |
| Graph memory DB unavailable | Fire-and-forget — logged but does not fail pipeline; `decisionKey` omitted from response |

### 9.1 Idempotency

No idempotency key for MVP. User is responsible for not calling execution twice for same plan. Future: add `idempotency_key` to TradePlan.

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

### 10.2 New Dependencies

```bash
npm install viem
```

### 10.3 New Environment Variables

Add to `.env` and `.env.example`:

```bash
# === Execution Agent (Hyperliquid Exchange) ===
MASTER_PRIVATE_KEY=0x...       # master wallet private key (only for approveAgent init)
AGENT_PRIVATE_KEY=0x...        # agent wallet private key (generated during init)
AGENT_WALLET_ADDRESS=0x...     # derived from agent private key (set after init)

# === Fill monitoring ===
EXECUTION_FILL_TIMEOUT_MS=15000  # max wait for WebSocket fill confirmation
EXECUTION_POLL_INTERVAL_MS=2000  # fallback poll interval if WS unavailable
```

### 10.4 Existing Variables (reused)

```bash
HYPERLIQUID_TESTNET=true        # existing
```

---

## 11. Implementation Phases

### Phase 1: Agent Wallet Setup
- `lib/agent/execution/client.ts` — `getAgentSigner()`, `getExchangeClient()`, `generateAgentWallet()`, `approveAgent()`
- `app/api/agent/execution/init/route.ts` — POST init endpoint
- `npm install viem`

**Checkpoint:** `POST /api/agent/execution/init` → generates agent key, approves via master, returns agentAddress.

### Phase 2: Order Building
- `lib/agent/execution/types.ts` — all internal types
- `lib/agent/execution/orders.ts` — `buildOrders()` for entry + OCO TP/SL
- Unit tests for order building (verify correct side, trigger condition, grouping)

**Checkpoint:** `buildOrders(longTradePlan)` returns correct wire format for entry + OCO TP/SL.

### Phase 3: Pipeline Orchestration
- `lib/agent/execution/pipeline.ts` — `runExecutionPipeline()`
- `app/api/agent/execution/route.ts` — POST execution endpoint
- Integration with HL testnet: place real order, verify order IDs returned

**Checkpoint:** `POST /api/agent/execution` with valid TradePlan + wallet → returns order IDs from HL testnet.

### Phase 4: Fill Monitoring
- `lib/agent/execution/ws-monitor.ts` — WebSocket SubscriptionClient for orderUpdates
- `app/api/agent/execution/status/route.ts` — GET status endpoint
- Fallback polling logic

**Checkpoint:** Place order → WebSocket detects fill → status endpoint returns `filled`.

### Phase 5: Emergency Cancel
- `app/api/agent/execution/cancel/route.ts` — cancel all open orders
- Uses `exchangeClient.cancelAll()` or iterates `exchangeClient.cancelByOid()`

**Checkpoint:** `POST /api/agent/execution/cancel` → all open orders cancelled.

### Phase 6: Tests
- Unit tests: `buildOrders` (long/short, trigger conditions, grouping), types Zod validation
- Integration tests: mock ExchangeClient → verify pipeline resolves correct order params
- Error path tests: missing agent key, leverage failure, HL API down

**Checkpoint:** All tests pass, coverage ≥ existing agent modules.

---

## 12. Testing Strategy

- **Unit tests:**
  - `buildOrders`: verify wire format for long/short, trigger conditions, grouping key, reduceOnly flag
  - `client.ts`: verify signer creation from private key, transport config (testnet/mainnet)
  - Types: Zod validation for ExecutionResult shape
  - Pipeline: mock ExchangeClient, verify TradePlan validation, error on missing agent key

- **Integration tests:**
  - Mock ExchangeClient + SubscriptionClient → full pipeline: build → place → monitor → return
  - Init: mock ExchangeClient → verify `approveAgent` called with correct params
  - Cancel: mock ExchangeClient → verify `cancelAll` or cancel-by-oid called

- **No E2E with live testnet** — requires real wallet with testnet USDC. Optional manual test.

Test framework: **vitest** (existing). Test locations: `__tests__/lib/agent/execution/` and `__tests__/app/api/agent/execution/`.

---

## 13. Boundaries

- **Always:**
  - Validate TradePlan with Zod before building orders
  - Check `autonomy_decision === "auto"` before executing (reject "approve" plans)
  - Verify AGENT_PRIVATE_KEY exists before placing orders
  - Set leverage BEFORE placing orders
  - Use `reduceOnly: true` for TP/SL trigger orders
  - Use `grouping: "normalTpsl"` for OCO TP/SL
  - Use `vaultAddress` pointing to master wallet
  - Use `withRetry` / `withTimeout` for all HL SDK calls
  - Record decision node to graph memory on every execution (fire-and-forget)
  - Record signal nodes/edges ONLY when ddReport is provided
  - Record outcome node on trade close via outcome endpoint

- **Ask first:**
  - Changing from testnet to mainnet
  - Adding position management (close existing before opening new)
  - Adding support for multiple positions per asset
  - Adding idempotency key to TradePlan
  - Changing TP/SL from OCO to independent orders

- **Never:**
  - Use master wallet private key for anything except `approveAgent` (init only)
  - Hardcode private keys
  - Ship to mainnet without additional security review
  - Call Execution Agent from Planning Agent (boundary — separate API calls)
  - Modify TradePlan fields (read-only consumer of Planning output)
  - Expose private keys in API responses (except init — which returns generated key once)

---

## 14. Resolved Decisions

1. **Agent wallet model: Auto-generate + SDK approve.** Agent wallet gets its own private key. `POST /api/agent/execution/init` generates key + calls `approveAgent()`. Key saved to `.env` for reuse. (Interview Q2 + Q3)

2. **Approval timing: Once at startup.** `approveAgent()` called once during init. Agent wallet key reused for all subsequent executions until user revokes. (Interview Q3)

3. **Master key storage: `.env` as `MASTER_PRIVATE_KEY`.** Only used during init for `approveAgent()`. Not used for trading. (Interview Q4)

4. **Fill monitoring: WebSocket with polling fallback.** `SubscriptionClient` for `orderUpdates` channel. 15s timeout. Fallback: poll `GET /status?oid=` every 2s. (Interview Q5)

5. **TP/SL: OCO grouping.** `grouping: "normalTpsl"` — one triggers, other auto-cancels. Safer than independent orders. (Interview Q6)

6. **Position management: None.** Place order regardless of existing positions. User may hedge. (Interview Q7)

7. **Emergency cancel: Yes.** `POST /api/agent/execution/cancel` cancels all open orders for agent wallet. (Interview Q8)

8. **No LLM in Execution Agent.** Pure deterministic code. All reasoning done by Planning Agent. Execution only translates TradePlan into Hyperliquid orders.

9. **Entry order type: Limit IoC.** Simulated market order — fills immediately at limit price, cancels unfilled remainder. No native market orders on Hyperliquid.

10. **Single asset per execution call.** MVP scope. Future: batch execution for multi-asset plans.

11. **Graph recording: Final step, fire-and-forget.** Recorded after orders placed + fill monitored. DB failure does not roll back the trade. (Interview with user)

12. **ddReport optional for execution.** TradePlan alone doesn't carry signals needed for graph recording. Execution accepts optional `ddReport` to extract signals. When absent, only decision node is recorded. (Interview with user)

13. **Outcome endpoint: POST /api/agent/execution/outcome.** Separate endpoint called when trade closes (TP/SL hit or cancel). Receives `decisionKey` + result. Upserts `OutcomeNode` + `RESULTED_IN` edge. (Interview with user)

---

*Spec relates to: `docs/odin-spec.md` §4.3 (Execution Agent), `docs/planning-agent-spec.md` §5 (TradePlan schema), `lib/agent/types.ts` (TradePlan shared contract)*
