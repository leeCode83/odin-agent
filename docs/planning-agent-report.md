# Planning Agent — Analisis Komprehensif

## ✅ Masalah 1: Leverage Selalu Rendah

**Data flow:**
```
LLM Perspective Subagent
  → menebak suggested_leverage (1-20, tanpa tools)
    → Aggregator ambil median 3 perspektif
      → capLeverage(median, max_leverage=100)
        → Output: median (biasanya 1-4x)
```

**Root cause — konseptual:** Risk engine hanya **membatasi**, tidak **menghitung**. Fungsi `capLeverage()` cuma `Math.min(suggested, max)`. Kalau LLM suggest 3x dan max 100x, output = 3x. Tidak ada rumus. LLM menebak seperti diminta menebak tekanan ban tanpa alat ukur — ia akan memilih angka aman.

Yang hilang: **tidak ada tool "hitung leverage optimal"** — padahal setiap trading firm nyata menghitung leverage dari rumus (Kelly Criterion, volatility-adjusted, confidence-weighted). Konsep fundamental: **leverage adalah OUTPUT dari risk engine, bukan INPUT dari LLM** (referensi: `crypto-trade-claude-code` — *"Leverage is the output of our risk, never the input."*).

---

## Masalah 2: NO_TRADE Dominan — Dua Perspektif Memilih Diam

**Data flow:**
```
Conservative: "Data tidak lengkap, R/R marginal, NO_TRADE"
Balance:      "Volatilitas tinggi, target 2% tidak feasible, NO_TRADE"
Aggressive:   "Bearish signal valid, SHORT dengan leverage 5x"

evaluateConsensus → Rule 2: 2/3 no_trade → NO_TRADE
→ Reasoning perspektif TIDAK PERNAH sampai ke user
→ Kenapa conservative & balance pilih no_trade? TIDAK DIJELASKAN
```

### 2a. Escape Hatch Prompt — Akar Utama

Prompt `makePlanningSystemPrompt`, baris 84:
> *"If market data is unavailable, set entry_price to 0 and side to no_trade."*

Ini adalah **escape hatch yang terlalu mudah**. Konsepnya: kalau satu tool call gagal (network timeout 15 detik, rate limit, data kosong), LLM bisa langsung menyimpulkan "data tidak tersedia" → `no_trade`. Tidak ada **retry logic** di level prompt. Tidak ada **gradasi**: "data sebagian tidak tersedia → confidence turun" vs "data benar-benar tidak ada → no_trade".

Conservative perspective secara natural akan menggunakan escape hatch ini. Balance perspective akan mengikutinya. Hasil: 2:1 → Rule 2 langsung menang.

### 2b. First-Match-Wins yang Membunuh Sinyal Kuat

`evaluateConsensus` (evaluate.ts:167):
```
Rule 1: All failed → FAILED
Rule 2: 2/3 no_trade → NO_TRADE    ← BERHENTI DI SINI
Rule 3: 2/3 funding flag → NO_TRADE
Rule 4: 3/3 same side + confidence ≥ 60 + profit feasible → ACCEPT
Rule 5: 2/3 same side + confidence ≥ 50 → ACCEPT
```

Rule 2 menang SEBELUM confidence dievaluasi. Skenario: conservative (confidence 0, no_trade), balance (confidence 20, no_trade), aggressive (confidence 85, SHORT dengan thesis solid). Hasil: NO_TRADE. Confidence 85 dari aggressive **tidak pernah dibaca**.

Konsep fundamental: **selective consensus**, bukan majority voting. Paper **TrustTrade** menunjukkan bahwa uniform trust (setiap agent dihitung sama) adalah bias — manusia memfilter, memberi bobot pada sinyal yang konsisten dan kuat.

### 2c. Transparency Vacuum

`evaluateConsensus` menghasilkan:
```json
{
  "decision": "NO_TRADE",
  "message": "2 of 3 perspectives returned no_trade — market not worth trading.",
  "noTradeReason": "..."
}
```

Tapi **tidak mengembalikan**:
- Alasan spesifik conservative: kenapa no_trade?
- Alasan spesifik balance: kenapa no_trade?
- Reasoning lengkap aggressive: kenapa dia yakin SHORT?
- Tools apa yang mereka gunakan?
- Apakah no_trade karena "data tidak tersedia" vs "memang analisis menunjukkan market jelek"?

User / downstream hanya melihat "2/3 bilang NO_TRADE" tanpa tahu "kenapa".

### 2d. Perspective Homogeneity — Tiga Orang Baca Buku yang Sama

Conservative, balance, dan aggressive membaca **DD report yang sama** dan menggunakan **tools yang sama**. Yang berbeda hanya **instruction**. Tapi kalau DD report-nya partial (2 dari 4 faktor gagal — yang sering terjadi di production), ketiga perspektif melihat data sampah yang sama.

| Perspective  | Job      | Reaksi terhadap data buruk                        |
| ------------ | -------- | ------------------------------------------------- |
| Conservative | Skeptis  | "Data tidak bagus → no_trade" (ini job dia)       |
| Balance      | Netral   | "Data tidak bagus → no_trade" (netral ikut skeptis)|
| Aggressive   | Optimis  | "Tetap ada sinyal bearish → SHORT" (ini job dia)  |

Hasil: 2:1 setiap kali DD report partial. Sistem tidak punya mekanisme untuk membedakan "no_trade karena memang market tidak layak" vs "no_trade karena data tidak lengkap". Padahal kode sudah mendeteksi `degradedFactors` tapi hanya menambah suffix ke message — tidak mengubah logika consensus.

---

## ✅ Masalah 3: Tools Kurang — LLM Menebak Angka Finansial

> **Status: SELESAI (T11-T13).** Prompt kini mengikat tiap field ke tool wajib (`entry_price` → `get_mark_price`, SL/TP → `compute_sltp`, position size → `compute_position_size`; tool gagal → `no_trade`). SDB Verifier (`lib/agent/planning/verifier.ts`) memvalidasi hasil return secara deterministik: entry_price tanpa `get_mark_price` → force `no_trade`, mismatch > 0.1% → override ke mark price, SL/TP/size override dari hasil tool terakhir yang sukses. Native tool calling diaktifkan di planning subagent (ThinkOptions diteruskan ke DD `think()`).

Paper **ATLAS** dan **FINCON** menekankan: **LLM untuk reasoning, bukan kalkulasi**. Semua perhitungan finansial harus deterministik.

Saat ini, perspective subagent diminta menghasilkan angka-angka ini **tanpa tools**:

| Field                        | Harusnya dihitung oleh                     | Saat ini  |
| ---------------------------- | ------------------------------------------ | --------- |
| `suggested_leverage`           | Kelly Criterion / volatility formula       | LLM nebak |
| `suggested_stop_loss`          | ATR × multiplier (ADA tool-nya!)           | LLM nebak |
| `suggested_take_profit`        | ATR × multiplier (ADA tool-nya!)           | LLM nebak |
| `entry_price`                  | Mark price dari HL (ADA tool-nya!)         | LLM nebak |
| `suggested_position_size_usdc` | Equity × risk% / priceRisk (ADA tool-nya!) | LLM nebak |

Ironisnya: tools `compute_atr`, `compute_sltp`, `compute_position_size`, `get_mark_price` **SUDAH ADA** di tool registry. Tapi prompt subagent hanya bilang *"Use at least 2 tools before returning"* — tidak mewajibkan tools spesifik untuk angka spesifik. LLM bisa memanggil `web_search` + `analyze_funding_regime`, lalu menebak semua angka trading.

Konsep fundamental: **tool enforcement**. Harusnya ada aturan keras: *"Untuk menghasilkan `entry_price`, kamu WAJIB memanggil `get_mark_price`. Untuk `suggested_stop_loss`, WAJIB memanggil `compute_sltp`."* Paper **crypto-trade-claude-code** menyebut ini *"the risk gate is code, not vibes."*

---

## ✅ Masalah 4: Tidak Ada Profit Feasibility Calculator

> **Status: SELESAI (T14-T16).** Tool `compute_profit_feasibility` ditambahkan (R:R, break-even win rate, expected move vs 3×ATR). Aggregator meng-override `profit_feasible` secara deterministik dengan `computeProfitFeasibility` (R:R ≥ 1.5 + target ≤ jarak TP) — penilaian LLM tidak lagi dipercaya.

Skenario user: target profit 2% untuk BTC. ATR BTC 1h ≈ $1200, mark price ≈ $87,000.

- SL distance = 1.5 × ATR = $1800 ≈ 2.07% dari entry
- TP distance = 3.0 × ATR = $3600 ≈ 4.14% dari entry
- Risk:Reward = 2.07 : 4.14 = 1:2

Dengan R:R 1:2, target 2% itu feasible. Tapi **tidak ada tool yang menghitung ini**. LLM menilai feasibility secara subjektif — dan conservative perspective akan selalu skeptis. Paper **"To Trade or Not to Trade"** menunjukkan bahwa agent dengan **risk-informed metrics** (VaR, CVaR, expected move) membuat keputusan JAUH lebih baik daripada agent dengan data mentah.

---

## Masalah 5: Aggregator Override Terlalu Lunak

`AGGREGATE_PROMPT`:
> *"If 2+ perspectives returned bearish signals but chose no_trade due to directional uncertainty (not because the asset is untradeable), **consider** overriding to short"*

"Consider" = LLM akan berkata "I considered it but decided against it." Tidak ada **decision rule** yang memaksa override. Aggregator juga LLM — ia punya bias yang sama dengan perspective subagents.

Konsep fundamental: **deterministic circuit breaker untuk LLM bias**. Setiap keputusan yang melibatkan uang harus punya lapisan kode yang tidak bisa di-debate oleh LLM.

---

## ✅ Masalah 6: Planning Agent Hardcode 4 Factor — DD Agent Sudah Dinamis

**Data flow:**
```
DD Agent buildFinalReport()
  → sections = { technical: {...}, sentiment: {...} }   (misal hanya 2 factor)
    → ddReport.sections hanya punya 2 key
      → compactDDReport(ddReport) → string ringkasan 2 section

Planning Agent agent.ts:311
  → expectedFactorCount = 4                              ← KONSTANTA MATI
    → ddConfidenceMultiplier = usableFactorCount / 4     ← DIVISOR SELALU 4
      → Kalau 2 factor usable: multiplier = 2/4 = 0.50x
      → Kalau 3 factor usable: multiplier = 3/4 = 0.75x
        → Confidence TIDAK PERNAH bisa 1.0 kecuali 4 factor

Planning Agent prompts.ts:118
  → "The DDReport contains analysis of 4 factors: technical, onchain, sentiment, fundamental."
    → LLM dijanjikan 4 factor, dapat 2 — mismatch ekspektasi
```

### 6a. Divisor Konstan — Confidence Dipotong Sepihak

`lib/agent/planning/agent.ts:311`:
```ts
const expectedFactorCount = 4
```

Dipakai sebagai divisor confidence multiplier di `agent.ts:508`:
```ts
const ddConfidenceMultiplier = Math.min(1, usableFactorCount / expectedFactorCount)
```

Dampak: kalau DD agent memutuskan suatu asset hanya perlu 2 factor (misal onchain tidak relevan untuk memecoin, atau sentiment tidak tersedia), planning agent tetap membandingkan dengan 4. Akibatnya confidence selalu dipotong — 2/4 = 0.5x, 3/4 = 0.75x. Tidak ada skenario di mana confidence multiplier bisa mencapai 1.0 kecuali keempat factor hadir.

Ini adalah **asumsi tersembunyi** bahwa DD agent akan selalu return 4 factor. Padahal DD agent sendiri sudah didesain dinamis:

- `lib/agent/due-diligence/agent.ts:116-123` — `buildFinalReport()` iterasi `factorReports` secara generik; tidak ada jaminan 4 entry
- `lib/agent/types.ts:40-45` — semua 4 section key di Zod schema adalah `.optional()`; legal untuk tidak hadir
- `lib/agent/due-diligence/types.ts:11` — `FACTOR_KEYS = ["technical", "onchain", "sentiment", "fundamental"]` sebagai const array; ini adalah **daftar semua factor yang mungkin**, bukan daftar factor yang **wajib** ada di setiap report

### 6b. Prompt LLM yang Menjanjikan 4 Factor

`lib/agent/planning/prompts.ts:118`:
```
The DDReport contains analysis of 4 factors: technical, onchain, sentiment, fundamental.
```

Planning agent memberi tahu LLM orchestrator bahwa DD report SELALU punya 4 factor. Tapi DD report yang masuk hanya punya 2 section. LLM bisa:
- **Kebingungan** — mencari 2 factor yang hilang dan menyimpulkan "data tidak lengkap" (trigger escape hatch prompt)
- **Halusinasi** — mengisi factor yang tidak ada dengan data karangan
- **Menurunkan confidence** — karena "2 dari 4 factor hilang" lebih buruk daripada "semua factor yang diminta (2) tersedia"

Ini memperparah Masalah 2 (NO_TRADE dominan): conservative perspective melihat 2/4 factor → "data tidak lengkap" → no_trade. Padahal DD agent sengaja hanya memberikan 2 factor karena memang hanya itu yang relevan.

### 6c. Apa yang Sudah Dinamis (Tapi Tidak Sampai)

Beberapa komponen sudah menangani dynamic factor count dengan benar:

| Komponen                                      | File:Line                                       | Status                                |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| `extractDegradedFactors()`                    | `lib/agent/shared/dd-utils.ts:21-36`            | Generik, tidak hardcode nama factor   |
| `compactDDReport()`                           | `lib/agent/planning/utils.ts:47-84`             | Iterasi `sections` secara generik     |
| `buildFinalReport()`                          | `lib/agent/due-diligence/agent.ts:116-123`      | Iterasi `factorReports` secara generik |
| `plannedFactorCount`                        | `lib/agent/planning/agent.ts:339`               | ✅ **FIXED — dinamis** (sections keys + fallback) |
| Prompt "4 factors"                            | `lib/agent/planning/prompts.ts`                 | ✅ **FIXED — dinamis** (`buildDDFactorContext`) |

Dua baris hardcode ini adalah bottleneck: semua kode di atasnya sudah siap untuk dynamic factor count, tapi dua konstanta ini memaksa asumsi 4 factor.

---

## Pattern Analysis — Apa yang Benar vs Apa yang Salah

**Yang sudah benar:**
- Arsitektur multi-perspective (conservative/balance/aggressive) — pattern ini valid, digunakan oleh TradingAgents dan FINCON
- DD Agent → Planning Agent → Execution Agent pipeline — separation of concerns baik
- Layer-1 consensus + Layer-2 autonomy gate — two-layer validation pattern benar
- ReAct loop dengan tool calling — pendekatan agentic yang solid
- Deterministic consensus rules (evaluateConsensus) — idenya benar, ordering-nya yang salah

**Yang salah secara fundamental:**
- LLM menebak angka keuangan yang seharusnya deterministik
- Majority voting tanpa confidence weighting
- Escape hatch prompt yang terlalu permisif
- Rule ordering yang membunuh sinyal kuat dari minority
- Tidak ada transparency ke user tentang reasoning perspektif
- Hardcode `expectedFactorCount = 4` — confidence multiplier selalu dibandingkan ke 4, padahal DD agent sudah dinamis

---

## Referensi Eksternal

| Paper/Source                                        | Konsep Kunci                                                                               | Relevansi            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| **TrustTrade** (arxiv 2603.22567)                   | Selective consensus > uniform voting; weighted by cross-agent agreement                     | Fix Rule 2 bias      |
| **TradingAgents** (arxiv 2412.20138)                | Bull/Bear debate + structured docs, bukan natural language saja                             | Transparency         |
| **ATLAS/Adaptive-OPRO** (arxiv 2510.15949)          | Prompt optimization; static vs dynamic separation; LLM untuk reasoning, bukan kalkulasi     | Fix prompt defeatism |
| **FINCON** (NeurIPS 2024)                           | Conceptual Verbal Reinforcement; manager-analyst hierarchy; deterministic risk layer        | Risk engine role     |
| **crypto-trade-claude-code** (GitHub)               | "Leverage is output, never input"; code-enforced risk gate LLM can't argue past             | Leverage fix         |
| **"To Trade or Not to Trade"** (arxiv 2507.08584)   | Risk-informed metrics improve trading decisions; builder-critic pattern                     | Feasibility calc     |

---

## Kesimpulan

Lima akar masalah konseptual:

1. **LLM menebak angka finansial** — semua kalkulasi trading (leverage, SL/TP, position size, entry price) seharusnya deterministik, dikerjakan oleh risk engine, bukan dihalusinasi oleh LLM. Tools-nya sudah ada, hanya tidak di-enforce.
2. **Escape hatch prompt terlalu mudah diakses** — kalimat *"if market data is unavailable... no_trade"* memberikan jalan keluar tanpa retry, tanpa gradasi. Conservative dan balance perspective menggunakannya setiap kali data tidak sempurna.
3. **Majority voting tanpa confidence weighting** — Rule 2 (2/3 no_trade → NO_TRADE) dieksekusi sebelum confidence dievaluasi. Sinyal kuat dari minority perspective tidak pernah dipertimbangkan.
4. **Tidak ada transparansi reasoning** — user hanya tahu "2/3 bilang NO_TRADE" tanpa tahu kenapa masing-masing perspektif mengambil keputusan itu.
5. **Hardcode `expectedFactorCount = 4`** — DD agent sudah dinamis (bisa return 2-4 factor), tapi planning agent tetap membandingkan confidence ke angka 4 sebagai divisor (`agent.ts:311`) dan prompt LLM menjanjikan 4 factor (`prompts.ts:118`). Akibatnya confidence selalu terpotong kalau factor < 4, dan LLM kebingungan saat DD report hanya punya 2 section.

Semua fix bersifat arsitektural, bukan tambal sulam.
