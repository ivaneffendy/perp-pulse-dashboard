# Perp Pulse Dashboard — Rebuild Design

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning
**Supersedes:** the single-pair dashboard currently on `main`

---

## 1. Context

The repo today implements **Phase 2 only**: a single-pair deep dive answering
*"is this pullback healthy or a falling knife?"* when a TradingView alert fires.

The playbook (V4 Crypto Perps, §II) makes the **first action of the daily routine**
"Check Perp Pulse Dashboard (Verdict Score & Macro Sentiment)" — a **Phase 1
pre-market radar** across the whole watchlist. That does not exist yet.

This rebuild adds Phase 1, keeps Phase 2, and restructures both sides of the
codebase to carry the additional computation.

### Authority of sources

**Playbook §VII is the authoritative scoring spec.** The PRD
(`~/Downloads/dashboard update planning.md`, plus a newer chat-pasted revision
adding Market Weather) reproduces §VII faithfully. Where PRD and playbook
disagree, the playbook wins; where the PRD is internally inconsistent or
technically wrong, §6 of this document records the correction.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Keep and extend the Cloudflare Worker.** Reject PRD §2/§6 "Zero Backend". | Binance `fapi` is geo-blocked from Indonesia *and* the Jakarta CF edge; `futures/data/*` sends no CORS headers. The PRD is also self-contradictory here — it forbids a backend while depending on `openInterestHist`. |
| D2 | **Two engines, separated, never summed.** §VII bias score (Phase 1) and `verdict()` pullback health (Phase 2). | They give opposite signs on price-down + OI-down because they answer different questions. Both readings are wanted. |
| D3 | **Watchlist: playbook's 8 as default, user-editable, wider Worker allowlist.** | §II's fixed-8 discipline is the default; the journal shows real rotation (HYPE, WLD, RENDER, ZEC, ONDO) that would otherwise need a redeploy. |
| D4 | **§VII score in v1. §III 5-pillar gate deferred**, but the data model must make pillars 1/2/5 derivable. | Ships the radar sooner without foreclosing the §III scorecard. |
| D5 | **Vanilla ES modules, no build step**, both sides. | GitHub Pages serves it directly; no CI, no toolchain rot. The risk lives in the compute layer, which gets tests regardless. |
| D6 | **Full refactor permitted.** | Explicitly cleared by the owner. Current files (355-line Worker, 343-line single-file page) cannot absorb this scope. |

---

## 3. Architecture

```
Phone browser (GitHub Pages, static)
  │
  ├─ GET /macro                     ──▶ Worker ──▶ CoinGecko, ETF source
  ├─ GET /asset?symbol=BTC          ──▶ Worker ──▶ Bybit (core) + OKX (extras)
  ├─ GET /asset?symbol=ETH          ──▶ Worker         + Binance (opportunistic)
  │  … one request per watchlist asset, in parallel
  │
  └─ GET /asset?symbol=X&deep=1     ──▶ Worker   (on tap only — adds book walls)
       │
       └─ Binance fapi DIRECT from the device (hybrid enrichment, unchanged)
```

### 3.1 Why fan-out, not one `/matrix` call

Cloudflare's free plan caps a Worker invocation at **50 subrequests**. Each asset
needs ~4 upstream calls; a single `/matrix` serving 12+ assets would exceed it.
One request per asset holds each invocation at ~4 regardless of watchlist size,
and lets the matrix render **progressively** — a slow OKX response for one symbol
does not blank the other rows.

Request volume: 8 assets + 1 macro = 9 requests per refresh. At a 5-minute
auto-refresh over an 8-hour window ≈ **900/day**, against a 100k/day free limit.

### 3.2 Endpoints

| Endpoint | Upstream calls | Edge TTL | Returns |
|---|---|---|---|
| `GET /asset?symbol=X` | ~6 (4 Bybit + 2 macro) | 30s | price, funding, OI + Δ1h/Δ4h, EMA34 state, equilibrium, nearest unmitigated FVG, sweep state, market mode, §VII score + per-layer breakdown |
| `GET /asset?symbol=X&deep=1` | ~14 | 15s | the above **plus** order-book walls, taker ratio, top-trader L/S, `verdict()` |
| `GET /macro` | ~2 | 900s | ETF net flow (BTC, ETH), BTC.D, USDT.D, TOTAL3 |

`&debug=1` and `&bins=1` diagnostics from the current Worker are retained.

Subrequest budget: the shallow `/asset` uses **4 Bybit calls only** (tickers,
4H kline, 1D kline, OI history) — OKX and Binance are not touched, because no
§VII layer depends on them. `deep=1` adds Bybit orderbook + account-ratio, the
five OKX calls, and three opportunistic Binance calls: **~14 total**, still well
inside the 50 ceiling for a single asset.

The deep order book (OKX `books-full`, 5000 levels) is deliberately excluded from
the matrix: it is a heavy payload needed only for the one asset that alerted.

### 3.3 Module layout

```
index.html            markup shell only
styles.css
src/
  main.js             boot, refresh loop, visibility handling, watchlist state
  api.js              Worker client: timeouts, per-asset partial failure
  matrix.js           Phase 1 grid render
  detail.js           Phase 2 panel render
  weather.js          BTC.D / USDT.D / TOTAL3 widget
  format.js           price / coin / percent formatters, per-symbol precision
  binance-enrich.js   existing hybrid client-side enrichment, extracted

worker/src/
  index.js            routing, CORS, response shaping — no market logic
  pairs.js            allowlist + per-venue symbol mapping
  sources/
    bybit.js  okx.js  binance.js  macro.js     fetch + normalize
  compute/
    klines.js         normalization, newest-first → oldest-first, drop unclosed
    ema.js  fvg.js  equilibrium.js  sweep.js  mode.js  walls.js
  score.js            §VII bias engine
  verdict.js          Phase 2 pullback health
```

`compute/*` are **pure functions over normalized arrays** — no fetch, no clock,
no config. That is what makes them testable, and they are where a silent error
does the most damage.

---

## 4. Data sources

| Field | Source | Notes |
|---|---|---|
| Price, **1h change**, 24h change, funding | Bybit `/v5/market/tickers` | `chg1h` from `prevPrice1h`, `chg24h` from `price24hPcnt` — no extra call. `chg4h` moved to the `deep=1` path. |
| 4H klines (200 bars) | Bybit `/v5/market/kline?interval=240&limit=200` | **returns newest-first — must be reversed** |
| 1D klines (2 bars) | Bybit `/v5/market/kline?interval=D&limit=2` | PDH/PDL |
| OI + Δ1h/Δ4h | Bybit `/v5/market/open-interest?intervalTime=1h&limit=5` | |
| Taker ratio, account L/S | OKX rubik; Bybit account-ratio fallback | |
| Order-book walls | OKX `books-full` (5000 lvl), Bybit `orderbook` fallback | `deep=1` only |
| Aggregate OI | Bybit + OKX + Binance-if-reachable | unchanged |
| BTC.D, USDT.D, TOTAL3 | CoinGecko `/api/v3/global` | `TOTAL3 = total_mcap × (100 − btc.d − eth.d) / 100` |
| Spot ETF net flow | Farside (Worker-side, long cache) | least reliable layer — see §5.1 |

Binance remains **opportunistic only**, both in the Worker and via the existing
client-side hybrid enrichment.

---

## 5. Scoring — Playbook §VII

Per-asset net score from **−5 to +5**, one point per layer.

Output: **≥ +3** `CLEAR TO LONG` 🟢 · **≤ −3** `CLEAR TO SHORT` 🔴 ·
**−2..+2** `CHOPPY / RANGE` 🟡

The response carries the per-layer breakdown, not just the total; the UI renders
all five so a total is never shown without its provenance.

### 5.1 Layer 1 — Spot ETF net flows

```
netFlow > +$50M  → +1
netFlow < −$50M  → −1
otherwise        →  0
```

- **BTC** uses BTC spot ETF flow; **ETH** uses ETH spot ETF flow.
- **All other assets use BTC flow as a macro proxy**, and the UI tags the chip
  `proxy` so it is never read as asset-specific.
- Flows are daily and publish on US business hours; a pre-market check in WIB may
  legitimately have no fresh figure. Missing/stale → `0`.
- On fetch failure the header exposes a manual `in / out / flat` toggle. The
  choice is persisted to `localStorage.ppd_etf` and sent as `?etf=` so that
  **scoring stays server-side** (D2 / single source of truth).

This is the flakiest layer by a wide margin. It must degrade to `0` silently and
visibly, never block a row.

### 5.2 Layer 2 — Funding rate

The playbook leaves `0–0.005%` and `0.01–0.015%` undefined. Fully partitioned,
undefined bands resolving to neutral (the conservative read):

```
rate <  0.000%  → +1     (shorts crowded)
rate >  0.015%  → −1     (longs crowded)
otherwise       →  0
```

Boundaries are exclusive: exactly `0.000` and exactly `0.015` score `0`.

### 5.3 Layer 3 — OI + price delta

**Kept literal to §VII.** Only the two named quadrants score:

```
price ↑ and OI ↑  → +1    (long buildup)
price ↓ and OI ↓  → −1    (long flush)
otherwise         →  0
```

**Measurement window — assumption.** Neither §VII nor the PRD states over what
period "price UP / OI UP" is measured. This design uses **1 hour**, reusing the
thresholds already tuned in the current Worker: price significant at
`|chg1h| > 0.15%`, OI significant at `|oiΔ1h| > 0.25%`. Both are exported as
named constants so the window can be retuned without touching the engine. Flagged
because a 4H window would produce a materially different, slower-moving layer.

§VII does not score the other two quadrants. Rather than invent signs, the
unscored states render as a **badge** — `fresh shorts` (price ↓ + OI ↑) or
`short covering` (price ↑ + OI ↓) — visible but score-neutral. This keeps the
engine faithful to the playbook while preserving the information, and it is
exactly the state where `verdict()` (§7) has more to say.

### 5.4 Layer 4 — EMA34 alignment (4H)

```
last closed 4H close  >  EMA34   → +1
last closed 4H close  <  EMA34   → −1
last 3 closes straddle EMA34     →  0   (oscillating)
```

- **200 bars**, not the PRD's 50. EMA34 seeded from `SMA(34)` has only 16 bars to
  converge at `limit=50`, leaving heavy seed bias that would flip this layer on
  noise. 200 bars ≈ 5× period is stable.
- Seed: `SMA` of the first 34 bars; then `EMA[i] = close[i]·k + EMA[i−1]·(1−k)`,
  `k = 2/35`.
- The **in-progress candle is excluded** everywhere. "Body close" means the close
  of the most recent *closed* 4H candle.

### 5.5 Layer 5 — Liquidity sweep (PDH/PDL)

From 2×1D klines. `PDH = prev.high`, `PDL = prev.low`.

```
today.low  < PDL  AND  price > PDL   → +1   (PDL swept + reclaimed)
today.high > PDH  AND  price < PDH   → −1   (PDH swept + rejected)
both true                            →  0   + badge "both swept"
neither                              →  0   ("inside PDH/PDL range")
```

**Day boundary is UTC**, matching exchange convention — not WIB (UTC+7). This is
called out because the owner's mental "previous day" may differ by seven hours.

---

## 6. Defects corrected from the PRD

### 6.1 FVG definitions are inverted (blocking)

PRD §4B states:

```
Bullish FVG  ⟵  Low[i−2] > High[i]
Bearish FVG  ⟵  High[i−2] < Low[i]
```

With klines ordered oldest→newest, `i−2` is the **older** candle, so
`Low[older] > High[newer]` describes a gap **down** — bearish, not bullish. Both
rows are swapped. Implemented correctly as:

```
Bullish FVG:  high[i−2] < low[i]     gap = [ high[i−2], low[i] ]
Bearish FVG:  low[i−2]  > high[i]    gap = [ high[i],   low[i−2] ]
```

### 6.2 `limit=50` too short for EMA34 (correctness)

See §5.4 — raised to 200 bars.

### 6.3 Funding bands leave gaps (spec hole)

See §5.2 — fully partitioned.

### 6.4 Zero-Backend clause is unimplementable (architecture)

See D1.

---

## 7. Phase 2 — pullback health (`verdict()`)

Retained essentially as-is, re-homed into `worker/src/verdict.js` and rendered in
the detail panel. It answers a **different question** from §VII:

| price ↓ + OI ↓ | |
|---|---|
| §VII bias score | `−1` bearish — *long flush* |
| `verdict()` | `ok` — *deleveraging pullback, POI mitigation has better odds* |

Both are correct for their own question. The UI therefore renders them in
separate blocks, each captioned with the question it answers — **"Bias (§VII)"**
and **"Pullback health"** — and they are never summed or averaged.

When the TradingView → Telegram push worker is built, it reuses `verdict.js`
directly. No second implementation.

---

## 8. Derived signals (non-scoring)

### 8.1 50% Equilibrium
Over the last **30 closed 4H bars**: `HH = max(high)`, `LL = min(low)`,
`EQ = (HH + LL) / 2`. `price < EQ` → **DISCOUNT**, `price > EQ` → **PREMIUM**.
Also reports percent distance to the swing low and swing high.

Feeds §III pillar 2 when that lands (D4).

### 8.2 FVG proximity
Scan 4H bars for gaps per §6.1. A gap is **mitigated** once a later candle trades
through ≥50% of its height; only unmitigated gaps are reported. Output: nearest
unmitigated gap, its direction, and percent distance from current price — or
`No-Man's Land` when none is within range.

### 8.3 Market mode
Swing points by 2-bar fractal over the last 30×4H bars (`high[j]` greater than
its two neighbours each side; inverse for lows). A **body close** beyond the prior
swing high/low is a BOS. If the most recent BOS is within the last **6 bars** →
`TREND` plus direction; otherwise `RANGE`.

This is not cosmetic: playbook §VI changes management rules in Range mode
(fade only, 100% exit at the midpoint, **no runners**).

---

## 9. UI

**Module 1 — Header.** Title, refresh, last-updated. Market Weather strip
(BTC.D / USDT.D / TOTAL3) styled deliberately muted — no traffic lights — so it
reads as context. Per the PRD's critical note, dominance **never** enters the
score. ETF status shows the auto value or the manual toggle.

**Module 2 — Matrix.** One dense row per asset, **sorted by |score| descending**
so extremes surface and `CHOPPY` sinks:

```
SOL   +4 🟢 CLEAR LONG    Discount · 1.2% → 4H swing low
      OI ↑  Fund ↓        Near 4H bull FVG (0.8%)   [TREND ↑] [PDL reclaimed]
```

Micro-trend arrow semantics, since PRD §5 does not define them: **OI arrow = sign
of `oiΔ1h`** (direction of change); **Funding arrow = sign of the current rate**
(not its change — no funding history is fetched). Tooltips state both.

**Detail (Phase 2).** Tap a row. The current single-pair view, re-homed — price,
funding, OI, taker, L/S, order-book walls, `verdict()` — preceded by the §VII
breakdown as five chips (`ETF +1 · Fund 0 · OI +1 · EMA +1 · Sweep +1`), with the
ETF chip tagged `proxy` on alts.

**Module 3 — Sanity-check legend.** Collapsible cheat sheet, content from PRD §5.

Mobile-first, dark, `max-width: 520px`, no charting library.

---

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| One asset's request fails | That row degrades; the matrix survives. Resolved fields render, missing ones show `n/a`. |
| Bybit (core) fails for a symbol | That row shows an error state. Fan-out isolates it from other rows. |
| OKX / Binance fail | Silent degrade to Bybit baseline — existing behaviour. |
| `/macro` fails | ETF layer → `0`; manual toggle surfaces; weather widget shows `—`. |
| HTTP 429 | Exponential backoff plus a visible warning (PRD §6). |
| Client timeout | 8s abort per request. |
| **Data stale >10 min** | **Values grey out and a staleness banner appears.** |

The staleness rule is a hard requirement: silently presenting 40-minute-old
prices as live is the worst available failure for a tool used to size positions.

Auto-refresh every 5 minutes, **paused on `visibilitychange`** — per §II the
charts are closed most of the day, so a hidden tab should not burn quota or battery.

---

## 11. Testing

`node --test`, no framework.

- **Golden fixtures** — real kline responses captured once and committed as JSON,
  asserted against EMA34 / equilibrium / FVG / sweep / mode outputs.
- **FVG inversion regression** — hand-built 3-candle bullish and bearish gaps
  asserting correct labelling. This is the defect most likely to silently return.
- **Score table** — all 5 layers × 3 states, plus boundaries: funding exactly
  `0.000` and exactly `0.015`; `chg1h` exactly `±0.15`; `oiΔ1h` exactly `±0.25`.
- **Kline normalization** — newest-first reversal and unclosed-candle exclusion,
  both easy to regress and silently wrong.
- **Worker smoke test** via `wrangler dev`.
- UI verified manually through the browser preview tools.

---

## 12. Deployment

Page → GitHub Pages from `main`, no build step. Worker → `npx wrangler deploy`
from `worker/`.

`localStorage` keys: `ppd_api`, `ppd_symbol` (existing), `ppd_watchlist`,
`ppd_etf` (new). `?api=` and `?symbol=` overrides retained.

---

## 13. Out of scope

- §III 5-pillar gate (D4 — next milestone; data model supports it).
- TradingView → Telegram push worker (roadmap; will reuse `verdict.js`).
- Liquidation heatmaps — no free source, unchanged from the existing decision.
- Deribit options skew.
- WS-maintained order book for deeper walls.

---

## 14. Known risks

1. ~~ETF feed confirmed dead~~ — **CORRECTED 2026-08-19 (post-deploy).** The
   403 was a missing `User-Agent`, not a permanent bot wall. With
   `UPSTREAM_HEADERS` set, Farside returns data from the Worker (verified live:
   `+$189.3M`) and layer 1 scores normally. Note Farside still 403s from a local
   `curl` — it is itself behind Cloudflare, and Worker egress is what passes —
   so this layer can only be verified in production. The manual toggle remains
   as a fallback.
1b. **Dominance source changed from CoinGecko to CoinPaprika.** CoinGecko's free
   tier rate-limits by IP; Cloudflare's egress IPs are shared across all Workers
   customers, so `/api/v3/global` returns **429 permanently**. CoinPaprika needs
   no API key. Both failures were invisible because errors were caught into
   nulls — `fetchMacro` now uses `allSettled` and reports reasons on
   `/macro?debug=1`.
2. **Watchlist vs. journal divergence.** NEAR, AVAX and ARB are in playbook §II
   but appear in zero of 28 logged trades; HYPE, WLD, RENDER, ZEC and ONDO are
   traded but not in §II. D3 resolves this operationally via an editable
   watchlist, but the playbook itself may deserve an update.
3. ~~Venue coverage unverified~~ — **RESOLVED 2026-08-19.** All 19 allowlisted
   bases (including HYPE, WLD, RENDER, ZEC, ONDO, ASTER, JTO) confirmed present
   on both Bybit linear (829 symbols) and OKX SWAP (452 instruments). Nothing
   needed removing.
4. **§VII's ETF layer is macro-wide**, so it applies an identical ±1 to every
   asset and never differentiates between them. Inherent to the spec, not a bug.
