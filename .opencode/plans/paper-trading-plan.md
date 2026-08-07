# Paper Trading Feature - Implementation Plan

## Overview

Paper trading system that runs full DD → Planning pipeline, monitors prices via Hyperliquid REST polling every 5 minutes with cross-detection for TP/SL, stores results in ArangoDB graph memory.

## Spec (Confirmed)

**Request body:**
```json
{
  "asset": "BTC",
  "userId": "user123",
  "walletAddress": "0x...",
  "targetProfitPercent": 5,
  "duration": "24h",
  "planReport": { ... }  // optional - skip DD+Planning if provided
}
```

**Duration enum:** `1h | 5h | 24h | 3d | 7d`

**Route flow:**
1. Validate body
2. If no `planReport`: run DD Agent → Planning Agent → get trade plan
3. If `planReport` provided: skip DD + Planning, use planReport directly
4. Pass trade plan to Paper Trading Service (monitoring)
5. Return paper trade ID + status

**Monitoring:**
- Price polling every 5 minutes via InfoClient SDK
- Gap detection between polls (cross-detection)
- Auto-close if TP/SL hit or duration expired
- Result stored in ArangoDB graph memory (same as real trades)

---

## Implementation Steps

### Step 1: Add Paper Trading Env Vars

**File:** `.env.example`

Add at end:
```bash
# === Paper Trading ===
PAPER_TRADING_POLL_INTERVAL_MS=300000  # 5 minutes
PAPER_TRADING_MAX_DURATION_MS=604800000  # 7 days (max)
```

No new secrets needed — reuse existing `HYPERLIQUID_TESTNET`, `ARANGO_*`, `DEEPSEEK_*`.

---

### Step 2: Create Paper Trading Types

**New file:** `lib/agent/paper-trading/types.ts`

```typescript
import { z } from "zod"
import { TradePlanSchema, TradePlan } from "../types"

// Duration options
export const PaperTradeDurationSchema = z.enum(["1h", "5h", "24h", "3d", "7d"])
export type PaperTradeDuration = z.infer<typeof PaperTradeDurationSchema>

// Duration to milliseconds
export const DURATION_MS: Record<PaperTradeDuration, number> = {
  "1h": 60 * 60 * 1000,
  "5h": 5 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
}

// Paper trade status
export const PaperTradeStatusSchema = z.enum([
  "pending",      // created, waiting for first poll
  "active",       // monitoring in progress
  "tp_hit",       // take profit reached
  "sl_hit",       // stop loss reached
  "expired",      // duration expired
  "cancelled",    // manually cancelled
  "error",        // monitoring error
])
export type PaperTradeStatus = z.infer<typeof PaperTradeStatusSchema>

// Price data point
export interface PriceSnapshot {
  price: number
  source: "hyperliquid" | "fallback"
  timestamp: string
  receivedAt: string
}

// Paper trade record (stored in ArangoDB)
export const PaperTradeSchema = z.object({
  _key: z.string().optional(),
  userId: z.string(),
  walletAddress: z.string(),
  asset: z.string(),
  category: z.string(),
  side: z.enum(["long", "short"]),
  tradePlan: TradePlanSchema,
  status: PaperTradeStatusSchema,
  duration: PaperTradeDurationSchema,
  startTime: z.string(),
  endTime: z.string(),
  lastCheckedPrice: z.number().nullable(),
  lastCheckedAt: z.string().nullable(),
  currentPrice: z.number().nullable(),
  entryPrice: z.number(),
  takeProfitPrice: z.number(),
  stopLossPrice: z.number(),
  pnlPercent: z.number().nullable(),
  pnlUsdc: z.number().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  priceHistory: z.array(z.object({
    price: z.number(),
    source: z.string(),
    timestamp: z.string(),
  })).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type PaperTrade = z.infer<typeof PaperTradeSchema>

// Request schema for POST /api/agent/paper-trading
export const PaperTradingRequestSchema = z.object({
  asset: z.string().min(1),
  userId: z.string().min(1),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  targetProfitPercent: z.number().positive().optional(),
  duration: PaperTradeDurationSchema.default("24h"),
  planReport: TradePlanSchema.optional(),
})

export type PaperTradingRequest = z.infer<typeof PaperTradingRequestSchema>

// Response schema
export interface PaperTradingResponse {
  paperTradeId: string
  status: PaperTradeStatus
  asset: string
  side: "long" | "short"
  entryPrice: number
  takeProfitPrice: number
  stopLossPrice: number
  duration: PaperTradeDuration
  endTime: string
  message: string
}
```

---

### Step 3: Create Paper Trading Service

**New file:** `lib/agent/paper-trading/service.ts`

Core responsibilities:
1. Start monitoring a paper trade
2. Poll price every 5 minutes
3. Cross-detection between polls
4. Auto-close on TP/SL or expiry
5. Store results in ArangoDB

```typescript
import { InfoClient } from "@nktkas/hyperliquid"
import { PaperTrade, PaperTradeStatus, PriceSnapshot, DURATION_MS } from "./types"
import { recordOutcome } from "@/lib/db/graph-memory"
import { getArangoClient } from "@/lib/db/arango-client"

const POLL_INTERVAL = parseInt(process.env.PAPER_TRADING_POLL_INTERVAL_MS || "300000")

// Start monitoring a paper trade
export async function startPaperTradeMonitoring(paperTrade: PaperTrade): Promise<void> {
  const endTime = new Date(paperTrade.endTime).getTime()
  
  const poll = async () => {
    const now = Date.now()
    
    // Check if duration expired
    if (now >= endTime) {
      await closePaperTrade(paperTrade._key!, "expired")
      return
    }
    
    // Fetch current price
    const snapshot = await fetchPrice(paperTrade.asset)
    if (!snapshot) {
      // Skip this poll, retry next interval
      setTimeout(poll, POLL_INTERVAL)
      return
    }
    
    // Cross-detection
    const lastPrice = paperTrade.lastCheckedPrice
    const currentPrice = snapshot.price
    
    if (lastPrice !== null) {
      const hit = detectCross(lastPrice, currentPrice, paperTrade)
      if (hit) {
        await closePaperTrade(paperTrade._key!, hit)
        return
      }
    }
    
    // Update paper trade
    await updatePaperTrade(paperTrade._key!, {
      lastCheckedPrice: currentPrice,
      lastCheckedAt: snapshot.receivedAt,
      currentPrice: currentPrice,
      $push: {
        priceHistory: {
          price: currentPrice,
          source: snapshot.source,
          timestamp: snapshot.timestamp,
        }
      }
    })
    
    // Schedule next poll
    setTimeout(poll, POLL_INTERVAL)
  }
  
  // Start first poll
  poll()
}

// Fetch price from Hyperliquid
async function fetchPrice(asset: string): Promise<PriceSnapshot | null> {
  try {
    const client = new InfoClient()
    const mids = await client.allMids()
    const mid = mids[asset]
    if (!mid) return null
    
    return {
      price: parseFloat(mid),
      source: "hyperliquid",
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error(`[PaperTrading] Price fetch failed for ${asset}:`, error)
    return null
  }
}

// Cross-detection: check if TP/SL was crossed between lastPrice and currentPrice
function detectCross(
  lastPrice: number,
  currentPrice: number,
  paperTrade: PaperTrade
): "tp_hit" | "sl_hit" | null {
  const { side, takeProfitPrice, stopLossPrice } = paperTrade
  
  if (side === "long") {
    // Long: TP if price went up through TP, SL if price went down through SL
    if (lastPrice < takeProfitPrice && currentPrice >= takeProfitPrice) return "tp_hit"
    if (lastPrice > stopLossPrice && currentPrice <= stopLossPrice) return "sl_hit"
  } else {
    // Short: TP if price went down through TP, SL if price went up through SL
    if (lastPrice > takeProfitPrice && currentPrice <= takeProfitPrice) return "tp_hit"
    if (lastPrice < stopLossPrice && currentPrice >= stopLossPrice) return "sl_hit"
  }
  
  return null
}

// Close paper trade and record outcome
async function closePaperTrade(
  paperTradeKey: string,
  reason: PaperTradeStatus
): Promise<void> {
  const db = getArangoClient()
  const collection = db.collection("paper_trades")
  
  // Get the paper trade
  const paperTrade = await collection.document(paperTradeKey)
  
  // Calculate PnL
  const { side, entryPrice, currentPrice } = paperTrade
  let pnlPercent = 0
  if (currentPrice && entryPrice) {
    pnlPercent = side === "long"
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100
  }
  
  const result = pnlPercent > 0 ? "profit" : pnlPercent < 0 ? "loss" : "breakeven"
  
  // Update paper trade
  await collection.update(paperTradeKey, {
    status: reason,
    pnlPercent,
    closedAt: new Date().toISOString(),
    closeReason: reason,
    updatedAt: new Date().toISOString(),
  })
  
  // Record to graph memory (same as real trades for pattern learning)
  await recordOutcome(paperTrade.decisionKey, {
    result,
    pnlPercent,
    exitPrice: currentPrice,
    exitReason: reason,
  })
}

// Update paper trade document
async function updatePaperTrade(key: string, updates: Record<string, any>): Promise<void> {
  const db = getArangoClient()
  const collection = db.collection("paper_trades")
  await collection.update(key, {
    ...updates,
    updatedAt: new Date().toISOString(),
  })
}
```

---

### Step 4: Create Paper Trading Route

**New file:** `app/api/agent/paper-trading/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server"
import { PaperTradingRequestSchema, DURATION_MS } from "@/lib/agent/paper-trading/types"
import { startPaperTradeMonitoring } from "@/lib/agent/paper-trading/service"
import { runDDPipeline } from "@/lib/agent/pipeline"
import { runPlanningPipeline } from "@/lib/agent/pipeline"
import { recordGraphMemory } from "@/lib/db/graph-memory"
import { getArangoClient } from "@/lib/db/arango-client"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = PaperTradingRequestSchema.safeParse(body)
    
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    
    const { asset, userId, walletAddress, targetProfitPercent, duration, planReport } = parsed.data
    
    let tradePlan = planReport
    let ddReport = null
    
    // Run DD + Planning if no planReport provided
    if (!tradePlan) {
      // Run DD Agent
      const ddResult = await runDDPipeline({ asset, userId, walletAddress })
      ddReport = ddResult.report
      
      // Run Planning Agent
      const planningResult = await runPlanningPipeline({
        asset,
        userId,
        walletAddress,
        targetProfitPercent,
        ddReport,
      })
      tradePlan = planningResult.report
    }
    
    // Calculate end time
    const startTime = new Date()
    const endTime = new Date(startTime.getTime() + DURATION_MS[duration])
    
    // Create paper trade record
    const paperTrade = {
      userId,
      walletAddress,
      asset,
      category: tradePlan.category || "unknown",
      side: tradePlan.side,
      tradePlan,
      status: "active" as const,
      duration,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      lastCheckedPrice: null,
      lastCheckedAt: null,
      currentPrice: null,
      entryPrice: tradePlan.entry_price,
      takeProfitPrice: tradePlan.take_profit,
      stopLossPrice: tradePlan.stop_loss,
      pnlPercent: null,
      pnlUsdc: null,
      closedAt: null,
      closeReason: null,
      priceHistory: [],
      createdAt: startTime.toISOString(),
      updatedAt: startTime.toISOString(),
    }
    
    // Store in ArangoDB
    const db = getArangoClient()
    const collection = db.collection("paper_trades")
    const result = await collection.save(paperTrade)
    const paperTradeId = result._key
    
    // Record to graph memory (decision node)
    await recordGraphMemory({
      userId,
      asset,
      category: paperTrade.category,
      decision: tradePlan.side === "long" ? "buy" : "sell",
      side: tradePlan.side,
      confidence: tradePlan.confidence?.overall || 0,
      tradePlan,
      autonomyDecision: "auto",
    })
    
    // Start monitoring (fire and forget)
    startPaperTradeMonitoring({ ...paperTrade, _key: paperTradeId })
    
    return NextResponse.json({
      paperTradeId,
      status: "active",
      asset,
      side: tradePlan.side,
      entryPrice: tradePlan.entry_price,
      takeProfitPrice: tradePlan.take_profit,
      stopLossPrice: tradePlan.stop_loss,
      duration,
      endTime: endTime.toISOString(),
      message: `Paper trade started. Monitoring ${asset} ${tradePlan.side} for ${duration}.`,
    })
    
  } catch (error) {
    console.error("[PaperTrading] Route error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
```

---

### Step 5: Add ArangoDB Collection

**Modify file:** `lib/db/setup.ts`

Add `paper_trades` to document collections:

```typescript
const DOCUMENT_COLLECTIONS = [
  "decisions",
  "signals",
  "outcomes",
  "assets",
  "dd_reports",
  "paper_trades",  // NEW
]
```

---

### Step 6: Create Paper Trading GET Route (Status)

**New file:** `app/api/agent/paper-trading/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server"
import { getArangoClient } from "@/lib/db/arango-client"

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params
    const db = getArangoClient()
    const collection = db.collection("paper_trades")
    
    const paperTrade = await collection.document(id)
    
    return NextResponse.json({
      id: paperTrade._key,
      asset: paperTrade.asset,
      side: paperTrade.side,
      status: paperTrade.status,
      entryPrice: paperTrade.entryPrice,
      currentPrice: paperTrade.currentPrice,
      takeProfitPrice: paperTrade.takeProfitPrice,
      stopLossPrice: paperTrade.stopLossPrice,
      pnlPercent: paperTrade.pnlPercent,
      duration: paperTrade.duration,
      startTime: paperTrade.startTime,
      endTime: paperTrade.endTime,
      closedAt: paperTrade.closedAt,
      closeReason: paperTrade.closeReason,
      priceHistory: paperTrade.priceHistory,
    })
    
  } catch (error) {
    return NextResponse.json(
      { error: "Paper trade not found" },
      { status: 404 }
    )
  }
}
```

---

### Step 7: Add JSDoc to All New Code

**All new files** must include JSDoc on:
- Every exported function/interface/type
- `@param` for each parameter
- `@returns` for return value
- `@example` where useful
- Brief description of purpose

Follow existing pattern in `lib/agent/execution/pipeline.ts` and `lib/data/hyperliquid.ts`.

---

### Step 8: Create Tests

**New file:** `__tests__/lib/agent/paper-trading/service.test.ts`

Test cases:
1. `fetchPrice` - success, failure, timeout
2. `detectCross` - long TP hit, long SL hit, short TP hit, short SL hit, no cross
3. `closePaperTrade` - profit, loss, breakeven, expiry
4. `startPaperTradeMonitoring` - full lifecycle mock

**New file:** `__tests__/app/api/agent/paper-trading/route.test.ts`

Test cases:
1. Validation error (400)
2. Success with planReport (skip DD+Planning)
3. Success without planReport (run DD+Planning)
4. Duration calculation
5. Graph memory recording

Follow existing test patterns from `__tests__/app/api/agent/planning/route.test.ts` and `__tests__/lib/agent/paper-trading/` (use `vi.mock()`, `vi.fn()`, `vi.hoisted()`, `NextRequest` objects).

---

### Step 9: Lint and Typecheck

Run after all code is written:
```bash
npx tsc --noEmit        # typecheck
npm run lint             # eslint
```

Fix any errors before finalizing.

---

## File Summary

| Action | File |
|--------|------|
| Modify | `.env.example` |
| Create | `lib/agent/paper-trading/types.ts` |
| Create | `lib/agent/paper-trading/service.ts` |
| Create | `app/api/agent/paper-trading/route.ts` |
| Create | `app/api/agent/paper-trading/[id]/route.ts` |
| Modify | `lib/db/setup.ts` |
| Create | `__tests__/lib/agent/paper-trading/service.test.ts` |
| Create | `__tests__/app/api/agent/paper-trading/route.test.ts` |

**All new files** include JSDoc (Step 7). Lint + typecheck verified (Step 9).

---

## Key Design Decisions

1. **Reuse existing types** - `TradePlan`, `DDReport`, `GraphPattern` used as-is
2. **Separation of concerns** - Route orchestrates DD→Planning, Service only monitors
3. **Graph memory reuse** - Paper trades stored same as real trades for pattern learning
4. **Cross-detection** - Compare lastPrice vs currentPrice, check if TP/SL was crossed
5. **Fire-and-forget monitoring** - `startPaperTradeMonitoring` runs async, no await
6. **Conservative fills** - Entry at trade plan entry price, not simulated market order
7. **No new secrets** - Reuse existing Hyperliquid, ArangoDB, DeepSeek configs

---

## Open Questions

1. Should paper trades have a separate ArangoDB collection or share `decisions`?
   - **Recommendation:** Separate `paper_trades` collection for clarity, but record to `outcomes` for graph learning
2. Should we add a GET endpoint to list all paper trades for a user?
   - **Recommendation:** Yes, useful for future dashboard
3. Should we add a DELETE endpoint to cancel a paper trade?
   - **Recommendation:** Yes, for manual cancellation

---

## Next Steps

After plan confirmation:
1. Implement types (Step 2) + JSDoc
2. Implement service (Step 3) + JSDoc
3. Implement routes (Steps 4, 6) + JSDoc
4. Modify ArangoDB setup (Step 5)
5. Add env vars (Step 1)
6. Write tests (Step 8)
7. Run lint + typecheck (Step 9), fix errors
