# Deployment

**Last Updated:** 2026-08-16

> Infrastructure, environment variables, and run commands.

---

## Overview

Odin Agent deploys as a standard Next.js Node.js application. It requires external services: DeepSeek API, ArangoDB, and Hyperliquid (testnet or mainnet).

---

## Infrastructure

| Component | Requirement |
|-----------|-------------|
| Runtime | Node.js 20+ |
| Framework | Next.js 16 |
| Database | ArangoDB 3.11+ |
| LLM | DeepSeek API access |
| Markets | Hyperliquid (testnet default) |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | LLM authentication | — |
| `DEEPSEEK_BASE_URL` | DeepSeek endpoint | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Fast model | `deepseek-v4-flash` |
| `DEEPSEEK_THINK_MODEL` | Reasoning model | `deepseek-v4-pro` |
| `ARANGO_URL` | ArangoDB URL | `http://127.0.0.1:8529` |
| `ARANGO_DB` | Database name | `odin` |
| `ARANGO_USER` / `ARANGO_PASSWORD` | DB credentials | — |
| `HYPERLIQUID_TESTNET` | Use testnet | `true` |
| `RISK_MAX_LEVERAGE` | Default max leverage | `10` |
| `RISK_PER_TRADE_PERCENT` | Risk per trade | `1` |
| `PAPER_TRADING_POLL_INTERVAL_MS` | Price poll interval | `300000` (5 min) |

Full list in `.env.example`.

---

## Run Commands

```bash
# Development
npm run dev

# Type check
npm run typecheck

# Tests
npm run test

# Production build & start
npm run build
npm start
```

---

## Database Setup

Run once to create collections:

```bash
npm run setup
```

This executes `scripts/setup-arangodb.ts`, which initializes the `odin` database and required collections for graph memory.

---

## Notes / Edge Cases

- ArangoDB is optional at runtime for the dashboard, but required for paper trade persistence and graph memory learning.
- The DeepSeek API key is mandatory; missing it causes all agent endpoints to fail.
- Hyperliquid testnet accounts without positions may have pruned clearinghouse state; a small test transaction can reinitialize it.

---

## Related Docs

- [Architecture](./ARCHITECTURE.md)
- [API](./API.md)
- [Database Module](./modules/db.md)
