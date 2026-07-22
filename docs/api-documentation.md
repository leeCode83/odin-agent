# API Documentation — Odin Agent

Base path: `/api/agent`

Error format across all endpoints:

```json
{ "error": "Human-readable message", "detail": "Optional detail string or array" }
```

---

## GET /api/agent/balance

Return detailed user balance from Hyperliquid clearing state.

**Query params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `walletAddress` | `string` | Yes | 0x-prefixed 40-char hex address |

**Response `200`:**

```json
{
  "walletAddress": "0x...",
  "withdrawable": 450.0,
  "accountValue": 1009.5,
  "totalMarginUsed": 559.5,
  "openPositions": 1,
  "crossMaintenanceMarginUsed": 8.42,
  "positions": [
    {
      "coin": "BTC",
      "side": "long",
      "sizeAsset": 0.01,
      "sizeUsdc": 500.0,
      "entryPrice": 50000.0,
      "unrealizedPnl": 10.0,
      "leverage": 5.0,
      "marginUsed": 100.0,
      "liquidationPrice": 48000.0,
      "returnOnEquity": 2.0,
      "fundingSinceOpen": -0.05
    }
  ]
}
```

**Errors:** 400 (missing/invalid walletAddress), 500 (fetch error)

---

## POST /api/agent/dd

Run Due Diligence pipeline for an asset. Fetches multi-factor analysis (technical, onchain, sentiment, fundamental).

**Request body:**

```json
{
  "asset": "BTC",
  "userId": "user_abc123"
}
```

**Response `200`:**

```json
{
  "report": {
    "asset": "BTC",
    "category": "large-cap",
    "timestamp": "2026-07-21T10:00:00Z",
    "sections": {
      "technical": { "score": 75, "summary": "...", "signals": ["trend_up"] },
      "onchain": { "score": 60, "summary": "...", "signals": ["inflow_high"] },
      "sentiment": { "score": 80, "summary": "...", "signals": ["positive"] },
      "fundamental": { "score": 70, "summary": "...", "signals": ["strong_ fundamentals"] }
    },
    "aggregated_thesis": "...",
    "confidence_score": 72,
    "risk_flags": ["flag1"],
    "errors": []
  },
  "timing": { "fetchMs": 1200, "llmMs": 3400, "totalMs": 4600 }
}
```

**Errors:** 400 (missing asset/userId, invalid JSON), 500 (pipeline failure)

---

## POST /api/agent/planning

Run Planning pipeline. Takes a DD report, produces a trade plan with position sizing, ATR-based SL/TP, confidence scoring, and autonomy decision.

**Request body:**

```json
{
  "ddReport": { /* DDReport object */ },
  "userId": "user_abc123",
  "walletAddress": "0x..."
}
```

**Response `200`:**

```json
{
  "plan": {
    "asset": "BTC",
    "side": "long",
    "entry_price": 50123.45,
    "position_size_usdc": 500.0,
    "position_size_contracts": 0.00997,
    "stop_loss": 49500.0,
    "take_profit": 51500.0,
    "leverage": 5.0,
    "confidence_score": 72,
    "confidence_breakdown": {
      "factor_alignment": 75,
      "historical_match": 60,
      "signal_strength": 80
    },
    "thesis": "...",
    "reasoning": "...",
    "autonomy_decision": "approve",
    "risk_flags": ["flag1"],
    "graph_patterns_used": [],
    "timestamp": "2026-07-21T10:00:00Z"
  },
  "timing": { "llmMs": 5000, "riskMs": 200, "graphMs": 300, "totalMs": 5500 }
}
```

**Errors:** 400 (missing fields, invalid ddReport), 500 (pipeline failure)

---

## POST /api/agent/trade

Run full 3-agent pipeline end-to-end: Due Diligence → Planning → Execution. Returns DD report, trade plan, execution result, and timing.

**Request body:**

```json
{
  "asset": "BTC",
  "userId": "user_abc123",
  "walletAddress": "0x..."
}
```

**Response `200`:**

```json
{
  "ddReport": { /* DDReport object */ },
  "plan": { /* TradePlan object */ },
  "execution": { /* ExecutionResult object */ },
  "timing": { "ddMs": 4600, "planMs": 5500, "execMs": 3000, "totalMs": 13100 }
}
```

**Errors:** 400 (missing fields), 503 (wallet not initialized), 502 (HL exchange error), 500

---

## POST /api/agent/trade/approve

Manually approve a pending trade plan and execute it. Used when autonomy_decision is `"approve"`.

**Request body:**

```json
{
  "tradePlan": { /* TradePlan object */ },
  "walletAddress": "0x...",
  "userId": "user_abc123",
  "ddReport": { /* optional DDReport */ }
}
```

**Response `200`:**

```json
{
  "execution": { /* ExecutionResult object */ },
  "ddReport": { /* DDReport if provided */ }
}
```

**Errors:** 400 (missing fields, invalid tradePlan), 503 (not initialized), 502 (HL error), 500

---

## POST /api/agent/trade/reject

Reject a trade plan without executing. Records the rejection to graph memory as `"cancelled"` outcome.

**Request body:**

```json
{
  "tradePlan": { /* TradePlan object */ },
  "userId": "user_abc123",
  "reason": "Optional rejection reason"
}
```

**Response `200`:**

```json
{
  "status": "rejected",
  "decisionKey": "decision_abc123",
  "message": "Trade rejected. Decision recorded to graph memory."
}
```

**Errors:** 400 (missing fields, invalid tradePlan), 500

---

## POST /api/agent/execution

Execute a trade plan directly (bypass DD and Planning). Places entry order + OCO (SL/TP) on Hyperliquid.

**Request body:**

```json
{
  "tradePlan": { /* TradePlan object */ },
  "walletAddress": "0x...",
  "userId": "user_abc123",
  "ddReport": { /* optional DDReport */ }
}
```

**Response `200`:**

```json
{
  "execution": {
    "status": "placed",
    "orders": [
      { "type": "entry", "oid": 12345, "status": "open" },
      { "type": "take_profit", "oid": 12346, "status": "open" },
      { "type": "stop_loss", "oid": 12347, "status": "open" }
    ],
    "groupId": "normalTpsl",
    "fillStatus": "pending",
    "fillAmount": null,
    "fillPrice": null,
    "timestamp": "2026-07-21T10:00:00Z",
    "decisionKey": "decision_abc123"
  },
  "timing": { "buildMs": 50, "placeMs": 800, "graphMs": 150, "totalMs": 1000 }
}
```

**Errors:** 400 (missing fields, invalid tradePlan, manual approval required), 503 (not initialized), 502 (HL error), 500

---

## POST /api/agent/execution/cancel

Cancel all open orders for the configured agent wallet. Reads AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS from env.

**Request body:** None

**Response `200`:**

```json
{
  "cancelled": 3,
  "message": "All orders cancelled"
}
```

**Errors:** 503 (wallet not initialized), 502 (HL exchange error)

---

## GET /api/agent/execution/status

Poll order fill status by order ID. Uses polling with configurable interval and max attempts.

**Query params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `oid` | `number` | Yes | Order ID (positive integer) |

**Response `200`:**

```json
{
  "oid": 12345,
  "status": "filled",
  "fillAmount": "0.01",
  "fillPrice": "50123.45"
}
```

Status values: `"filled"`, `"pending"`, `"cancelled"`, `"rejected"`.

**Errors:** 400 (missing/invalid oid), 500

---

## POST /api/agent/execution/init

Generate and approve a new agent Hyperliquid API wallet. Requires MASTER_PRIVATE_KEY in env. Idempotent — returns "Already initialized" if AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS exist.

**Request body:**

```json
{
  "agentName": "odin"
}
```

`agentName` is optional (defaults to `"odin"`).

**Response `200`:**

```json
{
  "agentAddress": "0x...",
  "agentName": "odin",
  "agentPrivateKey": "0x...",
  "approved": true,
  "message": "Agent wallet generated. Save AGENT_PRIVATE_KEY=... and AGENT_WALLET_ADDRESS=... to .env"
}
```

Idempotent response:

```json
{
  "agentAddress": "0x...",
  "approved": true,
  "message": "Already initialized"
}
```

**Errors:** 400 (MASTER_PRIVATE_KEY not set), 500

---

## POST /api/agent/execution/outcome

Record a trade outcome to graph memory. Used after position close to log profit/loss/cancelled for pattern learning.

**Request body:**

```json
{
  "decisionKey": "decision_abc123",
  "result": "profit",
  "pnlUsdc": 25.0,
  "pnlPercent": 5.0,
  "exitPrice": 51000.0,
  "exitReason": "Take profit hit"
}
```

`result` must be one of: `"profit"`, `"loss"`, `"breakeven"`, `"cancelled"`.

Optional fields: `pnlUsdc`, `pnlPercent`, `exitPrice`, `exitReason`.

**Response `200`:**

```json
{
  "recorded": true,
  "decisionKey": "decision_abc123",
  "outcomeKey": "outcome_abc123"
}
```

**Errors:** 400 (missing fields, invalid result), 500

---

## POST /api/agent/execution/close

Close all filled positions across all coins. Cancels existing open orders, then places reduceOnly IoC orders at aggressive prices (mid ± 1%) to force immediate fill. Records closed positions to graph memory as `"cancelled"` outcomes.

**Request body:**

```json
{
  "walletAddress": "0x..."
}
```

`walletAddress` is optional. If provided, positions are queried for this address instead of `AGENT_WALLET_ADDRESS` from env. Useful when the signing agent wallet differs from the wallet holding the positions.

**Response `200`:**

```json
{
  "closed": 2,
  "positions": [
    {
      "coin": "BTC",
      "side": "long",
      "size": "0.1",
      "closed": true,
      "oid": 100
    },
    {
      "coin": "ETH",
      "side": "short",
      "size": "2.0",
      "closed": false,
      "error": "Mid price not found for ETH"
    }
  ]
}
```

`closed` is the count of successfully closed positions. Each position entry has `coin`, `side` ("long" | "short"), `size`, `closed` (boolean), `oid` (order ID if placed), and optional `error` (if close failed).

**Errors:** 503 (wallet not initialized), 502 (HL exchange error)

---

## POST /api/agent/execution/close/{coin}

Close all filled positions for a specific coin (e.g. `BTC`, `ETH`). Same behavior as the close-all endpoint, scoped to one coin.

**Request body:**

```json
{
  "walletAddress": "0x..."
}
```

`walletAddress` is optional — same as close-all endpoint.

**Response `200`:**

```json
{
  "closed": 1,
  "positions": [
    {
      "coin": "BTC",
      "side": "long",
      "size": "0.1",
      "closed": true,
      "oid": 100
    }
  ]
}
```

**Errors:** 400 (coin parameter missing), 404 (coin not found in Hyperliquid universe), 503 (wallet not initialized), 502 (HL exchange error)
