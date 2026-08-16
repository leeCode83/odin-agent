# Frontend Module

**Last Updated:** 2026-08-16

> React dashboard UI for running DD, generating trade plans, and starting paper trades.

---

## Overview

The frontend is a single-page dashboard built with Next.js App Router. It uses GSAP for entrance animations, a shared React context for cross-section state, and custom hooks to call the agent APIs.

---

## Files

### `app/page.tsx`

- Dashboard entry. Wraps `DashboardInner` in `DashboardProvider`.
- Renders hero, DD section, and Plan section in a bento grid.

### `app/layout.tsx`

- Root layout with Geist font, dark mode, `TooltipProvider`, and `Toaster`.

### `context/dashboard-context.tsx`

- `DashboardProvider` holds `walletAddress`, `asset`, `ddReport`, and `tradePlan`.

### `hooks/use-dd.ts`

- `useDD` hook: POSTs to `/api/agent/dd` and holds the returned report.

### `hooks/use-planning.ts`

- `usePlanning` hook: POSTs to `/api/agent/planning` with `targetProfitPercent`.

### `components/dashboard/dd-section.tsx`

- Asset input, popular asset chips, and DD report rendering (score, sentiment, risk flags).

### `components/dashboard/plan-section.tsx`

- Target profit input, plan generation button, and trade plan rendering (entry, TP, SL, leverage).
- Supports NO_TRADE display and paper trade start.

### `components/dashboard/nav-bar.tsx`

- Top navigation bar.

---

## Key Functions / Classes / Exports

### `useDashboard()`

- Returns `{ walletAddress, setWalletAddress, asset, setAsset, ddReport, setDDReport, tradePlan, setTradePlan }`.
- Throws if used outside `DashboardProvider`.

### `DDSection`

- Renders the due diligence card. Calls `runDD(asset, walletAddress)` and syncs the analyzed asset into context.

### `PlanSection`

- Renders the trade plan card. Calls `generatePlan(asset, userId, walletAddress)`.
- `handleStartPaperTrade` POSTs to `/api/agent/paper-trading` with the current plan.

---

## Dependencies

- **Internal:** `context/dashboard-context`, `hooks/use-dd`, `hooks/use-planning`, `components/ui/*`
- **External:** `react`, `next`, `gsap`, `@gsap/react`, `lucide-react`

---

## Notes / Edge Cases

- The dashboard requires a wallet address to generate plans and start paper trades.
- Plan section is disabled until a DD report exists in context.
- Paper trade button is disabled for NO_TRADE plans.

---

## Related Docs

- [API](../API.md)
- [Architecture](../ARCHITECTURE.md)
