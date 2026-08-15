# API Documentation — Odin Agent

Base path: `/api/agent`

Error format across all endpoints:

```json
{ "error": "Human-readable message", "detail": "Optional detail string or array" }
```

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

Run Planning pipeline. Takes an asset, internally runs the DD agent (step 0), then the planning swarm produces a trade plan with position sizing, ATR-based SL/TP, confidence scoring, and autonomy decision.

**Request body:**

```json
{
  "asset": "BTC",
  "userId": "user_abc123",
  "walletAddress": "0x...",
  "targetProfitPercent": 100
}
```

- `asset`, `userId`, `walletAddress` — required, non-empty strings.
- `targetProfitPercent` — optional number, positive, max 1000 (decimals allowed, e.g. `20.5`).

**Response `200`:**

```json
{
  "report": {
    "asset": "BTC",
    "side": "long",
    "action": "LONG",
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
    "timestamp": "2026-07-21T10:00:00Z",
    "iterations": 3
  },
  "timing": { "totalMs": 5500, "agentMs": 5300 },
  "iterations": 3,
  "status": "complete"
}
```

`NO_TRADE` is a normal 200 with `report.action === "NO_TRADE"` and `status: "no_trade"` (zero-size placeholder plan).

**Response `503`** (circuit breaker tripped — DD 3 failures/5min or LLM 5 failures/10min):

```json
{
  "error": "PLANNING_UNAVAILABLE",
  "retryAfterSeconds": 60
}
```

**Response `500`** (spec §9.6):

```json
{
  "error": "PLANNING_FAILED",
  "message": "Planning pipeline failed for BTC: PLANNING_FAILED",
  "details": {
    "phase": "dd",
    "reports": [],
    "aggregation": null,
    "ddReport": null
  },
  "processingTimeMs": 1234
}
```

```json
{
  "error": "CONSENSUS_FAILED",
  "message": "Planning pipeline failed for BTC: PLANNING_FAILED",
  "details": {
    "phase": "evaluate",
    "reports": [],
    "aggregation": null,
    "ddReport": {}
  },
  "processingTimeMs": 5678
}
```

**Errors:** 400 (missing/invalid fields, invalid JSON, invalid targetProfitPercent), 503 (PLANNING_UNAVAILABLE), 500 (PLANNING_FAILED / CONSENSUS_FAILED)

---

## POST /api/agent/paper-trading

Create a paper trade (simulated position, no real orders). Accepts a pre-built `planReport`, or runs the DD → Planning pipeline internally (cached DD report used when available).

**Request body:**

```json
{
  "asset": "BTC",
  "userId": "user_abc123",
  "walletAddress": "0x...",
  "targetProfitPercent": 5,
  "duration": "24h",
  "planReport": { /* optional TradePlan — skips DD + Planning */ }
}
```

- `asset`, `userId`, `walletAddress` — required, non-empty strings.
- `targetProfitPercent` — optional number, positive, max 1000 (decimals allowed).
- `duration` — required, max 7 days (monitoring window).
- `planReport` — optional pre-built trade plan; when provided the DD + Planning pipeline is skipped.

**Response `201`** (trade created, monitoring started):

```json
{
  "id": "paper_trade_abc123",
  "status": "active",
  "asset": "BTC",
  "side": "long",
  "entryPrice": 50123.45,
  "stopLoss": 49500.0,
  "takeProfit": 51500.0,
  "leverage": 5.0,
  "duration": "24h",
  "startedAt": "2026-07-21T10:00:00Z"
}
```

**Response `200`** (planning decided NO_TRADE — record persisted, nothing monitored):

```json
{
  "id": "paper_trade_abc124",
  "status": "no_trade",
  "message": "Planning agent decided no trade for this asset",
  "reasoning": "..."
}
```

**Errors:**

- 400 — invalid JSON, schema violation, `UNKNOWN_ASSET` (asset not in Hyperliquid universe)
- 422 — `DD_AGENT_FAILED`, `PLANNING_FAILED`
- 503 — `HL_UNAVAILABLE` (Hyperliquid unreachable), database not available
- 500 — `PAPER_TRADING_FAILED`

---

## GET /api/agent/paper-trading/[id]

Fetch a paper trade's current status and P&L.

**Path params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Paper trade ID (document key) |

**Response `200`:**

```json
{
  "id": "paper_trade_abc123",
  "asset": "BTC",
  "side": "long",
  "entryPrice": 50123.45,
  "stopLoss": 49500.0,
  "takeProfit": 51500.0,
  "leverage": 5.0,
  "positionSizeUsdc": 500.0,
  "status": "active",
  "duration": "24h",
  "startedAt": "2026-07-21T10:00:00Z",
  "closedAt": null,
  "closedPrice": null,
  "pnlUsdc": null,
  "pnlPercent": null,
  "lastCheckedPrice": 50200.0,
  "lastCheckedAt": "2026-07-21T10:05:00Z",
  "createdAt": "2026-07-21T10:00:00Z"
}
```

`status` values: `"active"`, `"closed"`, `"no_trade"`.

**Errors:** 400 (missing id), 404 (not found), 503 (database not available), 500 (fetch error)
