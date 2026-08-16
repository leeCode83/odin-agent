# API Documentation

**Last Updated:** 2026-08-16

> Summary of backend endpoints and their request/response contracts.

---

## Overview

All agent-facing endpoints live under `/api/agent/*`. They accept JSON POST bodies and return structured reports validated by Zod schemas. Errors follow a taxonomy mapped to HTTP status codes.

---

## Endpoints

### `POST /api/agent/dd`

Runs the Due Diligence swarm for an asset.

**Request body:**
```json
{
  "asset": "BTC",
  "userId": "user123",
  "walletAddress": "0x..."
}
```

**Response:** `200` | `206` | `500`
```json
{
  "report": { /* DDReport */ },
  "timing": { "totalMs": 120000, "agentMs": 115000 }
}
```

- `200` — complete or partial report.
- `206` — partial (some factors failed).
- `500` — fatal pipeline failure.

---

### `POST /api/agent/planning`

Runs the Planning swarm (internally reuses cached DD or runs DD first), then builds a trade plan.

**Request body:**
```json
{
  "asset": "BTC",
  "userId": "user123",
  "walletAddress": "0x...",
  "targetProfitPercent": 100,
  "ddReport": { /* optional cached DDReport */ }
}
```

**Response:** `200` | `400` | `422` | `502` | `503`
```json
{
  "report": { /* TradePlan */ },
  "timing": { "totalMs": 90000, "agentMs": 85000 },
  "iterations": 2,
  "status": "complete",
  "ddCoverage": { "usableFactorCount": 3, "totalFactors": 4, "failedFactors": ["fundamental"] },
  "consensus": {
    "perspectiveBreakdown": [ ... ],
    "noTradeReasonDetail": { ... }
  }
}
```

**Error taxonomy:**
| Category | HTTP | Meaning |
|----------|------|---------|
| `dd` | `422` | DD report unusable |
| `llm` | `422` | LLM API or JSON parse failure |
| `data` | `502` | Upstream market data failure |
| `internal` | `500` | Unexpected bug or consensus collapse |
| circuit breaker | `503` | `PLANNING_UNAVAILABLE` with `retryAfterSeconds` |

---

### `POST /api/agent/paper-trading`

Creates a paper trade. Runs DD → Planning if `planReport` is omitted.

**Request body:**
```json
{
  "asset": "BTC",
  "userId": "user123",
  "walletAddress": "0x...",
  "duration": "24h",
  "targetProfitPercent": 5,
  "planReport": { /* optional TradePlan */ }
}
```

**Response:** `201` | `200` (no_trade) | `400` | `422` | `503`
```json
{
  "id": "abc123",
  "status": "active",
  "asset": "BTC",
  "side": "long",
  "entryPrice": 95000,
  "stopLoss": 92000,
  "takeProfit": 105000,
  "leverage": 5,
  "duration": "24h",
  "startedAt": "2026-08-16T12:00:00Z"
}
```

---

## Data Models

### `DDReport`
- `asset`: string — ticker analyzed
- `sections`: object with optional `technical`, `onchain`, `sentiment`, `fundamental`
- `overallScore`: number (0–100)
- `overallConfidence`: number (0–100)
- `risk_flags`: string[]
- `status`: `"complete" | "partial" | "failed"`

### `TradePlan`
- `asset`: string
- `side`: `"long" | "short"`
- `action`: `"LONG" | "SHORT" | "NO_TRADE"`
- `entry_price`, `stop_loss`, `take_profit`: positive numbers
- `position_size_usdc`, `leverage`: positive numbers
- `confidence_score`: integer 0–100
- `autonomy_decision`: `"auto" | "approve"`
- `timestamp`: ISO datetime

---

## Related Docs

- [Architecture](./ARCHITECTURE.md)
- [Due Diligence Module](./modules/due-diligence.md)
- [Planning Module](./modules/planning.md)
- [Paper Trading Module](./modules/paper-trading.md)
