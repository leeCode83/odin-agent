# Data Sources Module

**Last Updated:** 2026-08-16

> External market data and sentiment fetchers.

---

## Overview

The data layer abstracts Hyperliquid market data (candles, prices, funding, OI, user balances) and third-party sentiment feeds (Alternative.me Fear & Greed, CoinGecko). All fetches use timeouts and retries to avoid hanging the agent loops.

---

## Files

### `lib/data/hyperliquid.ts`

- Hyperliquid InfoClient wrapper.
- `fetchCandles`, `fetchOnchainData`, `fetchMarkPrice`, `fetchUserBalance`, `fetchUserEquity`, `fetchCandlesForATR`.
- Testnet/mainnet toggled via `HYPERLIQUID_TESTNET`.

### `lib/data/types.ts`

- Shared types for `CandleData` and `OnchainData`.

### `lib/data/sentiment/alternativeme.ts`

- Fear & Greed index fetcher.

### `lib/data/sentiment/coingecko.ts`

- CoinGecko market data fetcher.

---

## Key Functions / Classes / Exports

### `createHLClient()`

- Creates an `InfoClient` with `HttpTransport`. Defaults to testnet.

### `fetchMarkPrice(asset)`

- Returns mid price with 15s timeout and 2 retries.

### `fetchUserBalance(walletAddress)`

- Returns `UserBalance` including withdrawable cash, account value, margin used, and open positions.

### `fetchCandlesForATR(asset, interval?, window?)`

- Fetches OHLCV candles for ATR computation. Defaults to 20 candles at 1h interval.

---

## Data Models / Types

### `CandleData`

- `timestamp`, `open`, `high`, `low`, `close`, `volume`

### `OnchainData`

- `fundingRate`, `openInterest`, `markPrice`, `oraclePrice`, `premium`, `dayVolume`, `oiCapReached`

### `UserBalance`

- `walletAddress`, `withdrawable`, `accountValue`, `totalMarginUsed`, `openPositions`, `positions[]`

---

## Dependencies

- **External:** `@nktkas/hyperliquid`

---

## Notes / Edge Cases

- Hyperliquid testnet accounts without open positions may return null clearinghouse state.
- All fetchers use `withTimeout` and `withRetry` from `lib/utils.ts`.

---

## Related Docs

- [Due Diligence Module](./due-diligence.md)
- [Planning Module](./planning.md)
- [Database Module](./db.md)
