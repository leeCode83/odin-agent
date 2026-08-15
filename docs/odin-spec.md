# Odin — AI Agent Trading System (Hyperliquid Perpetual Futures)

> Single source of truth untuk project Odin. Hackathon track: **Finance & Commerce**.

---

## 1. Latar Belakang & Problem Statement

Mayoritas retail trader futures kripto rugi. Riset akademik nunjukin 68%–97% retail trader berakhir dengan modal lebih kecil dari awal, dan data spesifik futures market nunjukin 97% trader yang aktif lebih dari 300 hari akhirnya rugi, cuma 0.4% yang untung signifikan. Di crypto leverage khususnya, studi lain sebut angka serupa — sekitar 80–95% margin trader rugi.

**Akar masalah:**
1. **Leverage gak ampun** — pergerakan kecil bisa liquidate posisi.
2. **Market 24/7** — gak mungkin dipantau manusia terus-menerus.
3. **Riset multi-faktor makan waktu & expertise** — due diligence yang bener (technical + onchain + sentiment + fundamental) itu kerjaan level institutional/fund.
4. **Emosi** — FOMO, revenge trade, overleverage.

**Gap di solusi AI trading agent yang ada sekarang:** polarized antara full-autonomous (blackbox, gak dipercaya user buat taruh dana) atau manual/co-pilot (approval tiap trade, balik lagi ke masalah manusia gak bisa monitor 24/7 & gampang emosi approve). Kompetisi "Human vs AI" nunjukin ini nyata: 43% trader manusia kena liquidated sementara 30 AI agent semuanya survive, dengan ROI -4.48% (AI) vs -32.22% (manusia).

## 2. Solusi

Odin adalah AI agent trading dengan **confidence-gated autonomy**: melakukan due diligence komprehensif (technical + onchain + sentiment + fundamental) kayak tim analis, lalu eksekusi otonom **hanya** kalau confidence tinggi DAN dana di bawah threshold. Kalau confidence rendah atau dana besar, minta approval user.

Beda dari existing player (Kora, Singularry, Neyro, Bankr) yang pakai static mode selection (user pilih Autopilot vs Co-Pilot di awal) — Odin melakukan **dynamic/adaptive autonomy gating per-trade**, bukan per-mode. Agent sendiri yang memutuskan tiap kali mau auto-execute atau minta izin, berdasarkan confidence score aktual dari analisisnya.

## 3. Nama Project

**Odin** — dipilih oleh user.

## 4. Arsitektur — 2 Agent + Paper Trading

```
[Market Data + News + Onchain Data]
            │
            ▼
   ① Due Diligence Agent
   (technical + onchain + sentiment + fundamental,
    pipeline menyesuaikan kategori aset)
            │
            ▼  research summary (structured JSON)
   ② Planning & Decision Agent
   (rancang plan: entry/size/SL-TP/leverage,
    hitung confidence score,
    query Graph Memory buat historical pattern,
    cek terhadap threshold dana)
            │
      ┌─────┴─────┐
 confidence tinggi   confidence rendah /
 + dana < limit      dana > limit
      │                    │
      ▼                    ▼
 Paper Trading       Dashboard (approval UI)
 simulator                  │
 (mulai monitoring    user approve/reject
 posisi simulasi)           │
      │                    ▼
      └──────► Paper Trading (kalau approved)
            │
            ▼
   Record ke Graph Memory (ArangoDB)
   (decision + reasoning + outcome)
```

> ⚠️ **Execution Agent (live trading) sudah tidak ada.** Scope saat ini hanya sampai **paper trading** — rencana dieksekusi sebagai posisi simulasi (mark price Hyperliquid), bukan order asli. Live execution ke Hyperliquid (order limit + trigger TP/SL) bisa dibangun ulang di masa depan dari desain yang tercatat di roadmap (§4.4).

### 4.1 Due Diligence Agent
- Input: asset dari watchlist user.
- Kategorisasi aset (major/L1, DeFi token, meme coin, dst) menentukan sub-analisa mana yang relevan (contoh: meme coin skip fundamental, berat ke sentiment+onchain).
- 4 faktor analisa: **technical**, **onchain**, **sentiment**, **fundamental**.
- Output: DD Report berformat JSON standar (lihat §7).

### 4.2 Planning & Decision Agent
- Terima DD Report.
- Query Graph Memory (ArangoDB) buat cari pola/keputusan historis yang mirip.
- Rancang trade plan (entry, position size, SL/TP, leverage).
- Hitung confidence score.
- Bandingkan terhadap threshold dana & threshold confidence user → gate keputusan.
- Metodologi detail: lihat §6.

### 4.3 Paper Trading (posisi simulasi)

Menggantikan Execution Agent — trade plan dijalankan sebagai **paper trade** (simulasi, tanpa order asli ke Hyperliquid):

- Terima trade plan dari Planning Agent (`action` bukan `NO_TRADE`).
- Simpan record di collection `paper_trades` (ArangoDB), mulai monitoring harga.
- Monitoring via **polling berkala** (`PAPER_TRADING_POLL_INTERVAL_MS=300000` / 5 menit, durasi maksimal `PAPER_TRADING_MAX_DURATION_MS` / 7 hari) — posisi dianggap SL/TP kena kalau harga mark menyentuh level dari plan.
- Saat posisi closed (SL/TP kena atau durasi habis), hitung P&L simulasi (USDC + %) dan tulis outcome ke Graph Memory.
- API: `POST /api/agent/paper-trading` (buat), `GET /api/agent/paper-trading/[id]` (status) — lihat `docs/api-documentation.md`.

#### 4.3.1 Paper Trading tidak pakai order asli

Gak ada order limit/trigger yang dikirim ke Hyperliquid. Posisi murni simulasi: entry/exit ditentukan dari mark price yang dipoll. Ini menghindari risiko dana, tapi berarti SL/TP gak "dititip" ke exchange — evaluasi SL/TP dilakukan client-side oleh service monitoring.

#### 4.3.2 Monitoring (Polling, bukan WebSocket)

- Service `lib/agent/paper-trading/service.ts` mem-poll harga mark tiap interval, bandingkan dengan entry/SL/TP, update `lastCheckedPrice`/`lastCheckedAt` di record.
- Event-driven WebSocket (`orderUpdates`/`userEvents`) tidak dipakai — tidak ada order asli yang perlu di-track.

#### 4.3.3 Keterbatasan

- Paper trade tidak memantulkan slippage, funding cost, atau liquidity asli — P&L simulasi.
- Gak ada risk of exchange downtime karena gak ada order resting — tapi juga gak ada jaminan level ter-eksekusi seperti trigger order exchange-side.

### 4.4 Roadmap: Live Execution (future work)

Kalau mau lanjut ke trading asli di masa depan, desain yang sudah ada bisa dihidupkan lagi:

- **Entry** — limit order resting di orderbook, nunggu match price-time priority.
- **TP/SL** — trigger order (stop-market/limit, take-profit market/limit) dengan flag **`reduceOnly: true`**, trigger dievaluasi terhadap **mark price** (tahan wick/flash spike palsu).
- **Grouping (OCO-style)** — TP + SL sebagai satu paket via field `grouping` (`"normalTpsl"` / `"positionTpsl"`); salah satu ke-trigger, satunya auto-cancel oleh exchange — gak ada race condition.
- **Monitoring** — event-driven via WebSocket `SubscriptionClient` (channel `orderUpdates`/`userEvents`) buat update Graph Memory saat fill.
- **Known limitation** — kalau Hyperliquid downtime, trigger order tidak tereksekusi sampai platform normal (risiko level exchange, perlu disclaimer ke user).

## 5. Wallet & Custody Model

Odin non-custodial, pakai konsep **Hyperliquid API Wallet (Agent Wallet)**:

- User deposit USDC ke akun Hyperliquid miliknya sendiri (via main wallet, bridge dari Arbitrum) — dana tetap di kontrol user.
- User approve satu **Agent Wallet** terpisah dengan permission terbatas: **cuma bisa trade, TIDAK bisa withdraw**.
- Private key Agent Wallet disimpan encrypted di server (collection `agent_wallets`) — **dipakai nanti kalau live execution aktif** (§4.4); untuk paper trading key ini tidak diperlukan.
- User bisa **revoke approval kapan saja** langsung dari Hyperliquid app — agent langsung kehilangan akses.
- Withdraw dana dilakukan user langsung dari Hyperliquid (native), agent sama sekali gak punya akses withdraw.

## 6. Metodologi Planning & Decision (Hybrid)

Bukan pure-LLM decision — kombinasi reasoning + kode deterministic:

1. **LLM reasoning (thinking mode)** — synthesize DD Report jadi trading thesis (arah, alasan, risk factor).
2. **Structured confidence scoring** — confidence tiap factor (DD) & perspective (Planning) dihitung **deterministik dari execution signals** (formula di `lib/agent/shared/confidence.ts`: tool success, error jenis, empty data, cakupan tool, alasan berhenti), bukan verbalisasi LLM — confidence LLM diabaikan, `null` tetap `null` (faktor dianggap failed).
3. **Self-consistency check** — reasoning dijalankan 2–3x (temperature rendah); hasil konsisten → confidence naik, hasil beda-beda → confidence turun otomatis (proxy uncertainty).
4. **Deterministic risk engine** (kode biasa, bukan LLM) — hitung position size pakai fixed-fractional risk model (risk maks 1–2% equity per trade), tentukan SL/TP dari volatility (ATR-based).
5. **Gate logic** (kode biasa) — bandingkan confidence & position size ke threshold user → auto-execute atau push approval ke dashboard.

Prinsip: LLM buat "mikir" (thesis & confidence), kode deterministic buat "hitung risiko" (position size, SL/TP) — biar angka penting gak murni hasil LLM hallucination.

## 7. Format DD Report (Standardized)

```json
{
  "asset": "BTC",
  "category": "major",
  "timestamp": "2026-07-16T10:00:00Z",
  "sections": {
    "technical": { "score": 72, "summary": "...", "signals": ["RSI oversold", "..."] },
    "onchain": { "score": 65, "summary": "...", "signals": ["funding rate negatif", "..."] },
    "sentiment": { "score": 58, "summary": "...", "sources": ["..."] },
    "fundamental": { "score": null, "summary": "N/A untuk kategori major", "note": "..." }
  },
  "aggregated_thesis": "...",
  "confidence_score": 78,
  "risk_flags": ["high funding cost", "..."]
}
```

`category` menentukan section mana yang aktif per aset. Format konsisten ini juga dipakai buat konversi deterministic ke Graph Memory (lihat §8).

## 8. Graph Memory (ArangoDB)

- **Node**: `Asset`, `Category`, `Signal`, `Decision`, `Outcome`.
- **Edge**: `Decision -[ANALYZED]-> Asset`, `Decision -[TRIGGERED_BY]-> Signal`, `Decision -[RESULTED_IN]-> Outcome`, `Asset -[BELONGS_TO]-> Category`.
- Karena Decision object sudah structured JSON, konversi ke graph adalah **deterministic mapping** (bukan butuh LLM lagi) — mapper function insert node/edge via `arangojs`, dijalankan saat outcome tercatat (paper trade closed / pipeline selesai).
- Planning Agent query graph ini buat cari: "pola sinyal X di kategori aset Y historically berujung outcome apa?" — jadi semacam explainable memory, bukan cuma blackbox confidence number.

## 9. Database Strategy

**Satu instance ArangoDB (multi-model), gak perlu SQL terpisah:**

- **Document collections** (data flat/relational-like): `users` (wallet address, profile), `agent_wallets` (encrypted private key), `watchlist_config`, `risk_thresholds`, `sessions`.
- **Graph collections**: `decisions`, `signals`, `outcomes`, `assets` + edge collections (§8).

Kapan baru butuh SQL beneran (Postgres dkk): kalau nanti production-scale dan butuh strict ACID transactional integrity (ledger keuangan, reconciliation dana) atau tooling ekosistem lebih matang (ORM/migration). Untuk scope hackathon/portfolio project, ArangoDB cukup.

## 10. Auth

Wallet-based login, bukan email/password:

- **SIWE (Sign-In With Ethereum)** buat verifikasi wallet ownership.
- Session token JWT.
- User profile disimpan di collection `users` (ArangoDB), keyed by wallet address.

## 11. Asset Scope

Configurable — semua aset yang listed di Hyperliquid bisa masuk watchlist user. Kategori aset (major/L1, DeFi, meme, dst) menentukan due diligence pipeline mana yang jalan.

## 12. Kategorisasi Aset

Kategori menentukan sub-analisa mana yang aktif di Due Diligence Agent (§4.1) dan bobot tiap faktor di confidence scoring.

### 12.1 Daftar Kategori

| Kategori | Contoh | DD Aktif | Bobot Khusus |
|---|---|---|---|
| `major` | BTC, ETH | technical, onchain, sentiment, fundamental | Onchain + technical leading, fundamental = macro |
| `layer1` | SOL, SUI, AVAX | technical, onchain, sentiment, fundamental | Fundamental = ekosistem, TVL, dev activity |
| `defi` | UNI, AAVE, LINK | technical, onchain, sentiment, fundamental | Fundamental = protocol revenue, tokenomics |
| `meme` | DOGE, PEPE, WIF | technical, onchain, sentiment | **Skip fundamental.** Berat ke sentiment + onchain |

### 12.2 Fallback

Aset yang belum dikategorikan di-mapping — gunakan `major` sebagai default (full pipeline, safe: better over-analyze than skip).

### 12.3 Implementasi

Disimpan sebagai kode (bukan file config terpisah) di module `lib/asset-categories.ts`:

```ts
type CategoryConfig = {
  activeSections: ("technical" | "onchain" | "sentiment" | "fundamental")[];
};

const CATEGORIES: Record<string, CategoryConfig> = {
  major:  { activeSections: ["technical", "onchain", "sentiment", "fundamental"] },
  layer1: { activeSections: ["technical", "onchain", "sentiment", "fundamental"] },
  defi:   { activeSections: ["technical", "onchain", "sentiment", "fundamental"] },
  meme:   { activeSections: ["technical", "onchain", "sentiment"] },
};

const ASSET_CATEGORY: Record<string, string> = {
  BTC: "major", ETH: "major",
  SOL: "layer1", SUI: "layer1", AVAX: "layer1",
  UNI: "defi", AAVE: "defi", LINK: "defi",
  DOGE: "meme", PEPE: "meme", WIF: "meme",
};

export function getCategory(asset: string): CategoryConfig {
  const category = ASSET_CATEGORY[asset] ?? "major";
  return CATEGORIES[category];
}
```

## 13. Autonomy Gating Logic

```
IF confidence_score >= threshold_confidence
   AND position_size <= threshold_fund
THEN auto-execute (paper trade otomatis aktif)
ELSE push to dashboard for user approval
```

Kedua threshold (`threshold_confidence`, `threshold_fund`) configurable per user.

> Saat ini "auto-execute" berarti **paper trade otomatis dimulai** (posisi simulasi). Live execution otomatis adalah masa depan (§4.4).

## 14. LLM Model per Agent (DeepSeek)

> ⚠️ Alias lama `deepseek-chat` / `deepseek-reasoner` **retired 24 Juli 2026**. Pakai nama model baru: `deepseek-v4-flash` (non-thinking/thinking mode) atau `deepseek-v4-pro`.

| Agent | Model | Alasan |
|---|---|---|
| Due Diligence Agent | `deepseek-v4-flash` (non-thinking) | Ekstraksi & summarize data, gak butuh deep reasoning, murah & cepat, throughput tinggi (banyak aset di-scan). |
| Planning & Decision Agent | `deepseek-v4-flash` (thinking mode) / `deepseek-v4-pro` | Butuh reasoning terdalam — thesis, confidence score, position sizing. |

## 15. Flow End-to-End User

1. **Landing** → user buka dashboard, connect wallet (wagmi/RainbowKit).
2. **Setup config** → pilih watchlist aset, set threshold confidence & threshold dana per trade. (Untuk paper trading **tidak perlu** deposit USDC atau approve Agent Wallet — gak ada dana asli.)
3. **Agent jalan background** → scheduler jalanin DD Agent → Planning Agent tiap interval/trigger, untuk tiap aset di watchlist.
4. **Notifikasi** → kalau confidence tinggi, paper trade otomatis mulai + muncul di log dashboard; kalau butuh approval, muncul card "Pending Approval" dengan DD report + plan.
5. **User approve/reject** kapan saja buka dashboard (gak harus real-time).
6. **Monitoring** → paper trade dipantau service polling (SL/TP simulasi, durasi maksimal 7 hari), history & P&L kelihatan di dashboard.
7. **Live trading (masa depan)** → kalau fitur execution aktif (§4.4), baru ada langkah deposit USDC, approve Agent Wallet trade-only, dan withdraw dana langsung dari Hyperliquid.

## 16. Background Execution (Browser Independence)

Agent **harus** jalan server-side, bukan bergantung ke browser kebuka. Next.js App Router gak punya persistent background process bawaan, jadi butuh scheduler terpisah:

- **Vercel Cron Jobs** (kalau deploy di Vercel) — trigger endpoint tiap interval.
- Atau self-host: **node-cron** / **BullMQ** (queue) jalan di server terpisah, trigger agent pipeline independen dari browser session.

Dashboard cuma jendela buat lihat & approve, bukan yang "menjalankan" agent.

## 17. Tech Stack

- **Frontend + Backend**: Next.js 16 (dashboard + API routes/server actions buat orchestrate 2 agent + paper trading)
- **Wallet connect**: wagmi (+ viem)
- **Execution**: `@nktkas/hyperliquid` SDK (TypeScript) — dipakai buat market data & harga mark (paper trading); order execution live = masa depan (§4.4)
- **Memory/DB**: ArangoDB (multi-model: document + graph), driver `arangojs`
- **LLM**: DeepSeek API (`deepseek-v4-flash`, `deepseek-v4-pro`)
- **Auth**: SIWE + JWT session
- **Venue**: Hyperliquid perpetual futures (testnet dulu buat dev/demo)

## 18. Scope MVP vs Stretch (Hackathon Timeline)

- **MVP**: DD Agent + Planning Agent + paper trading jalan end-to-end di testnet, due diligence basic (technical+onchain dulu, sentiment+fundamental kalau waktu cukup), dashboard approval simpel, graph memory basic record+query.
- **Stretch**: fundamental analysis penuh, Telegram notifikasi, multi-asset paralel monitoring, backtesting dashboard.

---

## 19. Resources & Dokumentasi

| Kategori | Resource | Link |
|---|---|---|
| Hyperliquid | Dokumentasi API resmi | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api |
| Hyperliquid | Agent Wallet / Approve API Wallet | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#approve-an-api-wallet |
| Hyperliquid | TypeScript SDK — `@nktkas/hyperliquid` (GitHub) | https://github.com/nktkas/hyperliquid |
| Hyperliquid | TypeScript SDK — dokumentasi lengkap | https://nktkas.gitbook.io/hyperliquid |
| Hyperliquid | TypeScript SDK — npm package | https://www.npmjs.com/package/@nktkas/hyperliquid |
| Hyperliquid | Python SDK (referensi, opsional) | https://github.com/hyperliquid-dex/hyperliquid-python-sdk |
| Next.js | Dokumentasi resmi Next.js | https://nextjs.org/docs |
| wagmi | Dokumentasi resmi wagmi | https://wagmi.sh |
| viem | Dokumentasi resmi viem | https://viem.sh |
| SIWE | Sign-In With Ethereum spec & docs | https://docs.login.xyz |
| ArangoDB | Dokumentasi resmi ArangoDB | https://docs.arangodb.com |
| ArangoDB | JavaScript driver — `arangojs` (GitHub) | https://github.com/arangodb/arangojs |
| ArangoDB | `arangojs` — npm package | https://www.npmjs.com/package/arangojs |
| ArangoDB | AQL (query language) reference | https://docs.arangodb.com/stable/aql/ |
| DeepSeek | Dokumentasi resmi API & pricing | https://api-docs.deepseek.com/quick_start/pricing/ |
| DeepSeek | List models | https://api-docs.deepseek.com/api/list-models/ |

---

*Dokumen ini adalah single source of truth untuk project Odin. Update dokumen ini setiap ada keputusan arsitektur baru.*
