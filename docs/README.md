# Odin Agent Documentation

**Last Updated:** 2026-08-16

> AI-powered trading intelligence dashboard for Hyperliquid perpetuals.

---

## Overview

Odin Agent is a Next.js application that runs multi-agent due diligence (DD) and trade planning for Hyperliquid assets. It uses LLM-driven swarms for analysis, deterministic risk engines for trade numbers, and ArangoDB graph memory for historical pattern learning.

---

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript 5
- **Styling:** Tailwind CSS v4, shadcn/ui (Base UI primitives)
- **Animation:** GSAP + `@gsap/react`
- **Data:** Hyperliquid Info API (`@nktkas/hyperliquid`), CoinGecko, Alternative.me
- **Database:** ArangoDB (graph memory + caching)
- **LLM:** DeepSeek API via OpenAI SDK
- **Validation:** Zod v4
- **Testing:** Vitest

---

## Quickstart

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DEEPSEEK_API_KEY, ARANGO_URL, etc.

# Run DB setup (creates collections)
npm run setup

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Project Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run test` | Run Vitest suite |
| `npm run typecheck` | TypeScript type check |
| `npm run setup` | Bootstrap ArangoDB collections |

---

## Related Docs

- [Architecture](./ARCHITECTURE.md)
- [API](./API.md)
- [Deployment](./DEPLOYMENT.md)
- [Due Diligence Module](./modules/due-diligence.md)
- [Planning Module](./modules/planning.md)
- [Paper Trading Module](./modules/paper-trading.md)
- [Database Module](./modules/db.md)
- [Data Sources Module](./modules/data.md)
- [Frontend Module](./modules/frontend.md)
