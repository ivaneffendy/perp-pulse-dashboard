# perp-pulse-dashboard

A personal, mobile-first **crypto perps confluence dashboard**. It is a quick
"read the tape" tool — **not** a trading bot and not an alerting system. The
owner is a discretionary trader running an SMC / institutional-S&D playbook
around a 9-to-5 job.

It serves **two distinct phases**, and every feature should trace to one:

- **Phase 1 — pre-market radar (1–2 min).** Scan the whole watchlist, get a
  −5..+5 bias score per asset, see which coins sit at extreme POIs. Playbook §II
  makes this the *first action* of the daily routine.
- **Phase 2 — alert sanity check (30 s).** A TradingView alert fires at a POI:
  *is this a healthy pullback (absorption) or a falling knife (cascade)?*

## Architecture

```
Phone browser (GitHub Pages, static, no build step)
  ├─ GET /macro              ─▶ Worker ─▶ CoinGecko (dominance), Farside (ETF)
  ├─ GET /asset?symbol=BTC   ─▶ Worker ─▶ Bybit  (4 calls) + macro (2, cached)
  ├─ GET /asset?symbol=ETH   ─▶ Worker      … one request per watchlist asset,
  │  … fanned out in parallel                  fired concurrently
  └─ GET /asset?symbol=X&deep=1 ─▶ Worker ─▶ + OKX + Binance + Bybit book (~14)
       └─ Binance fapi DIRECT from the device (hybrid client-side enrichment)
```

### Why fan out instead of one `/matrix` call
A Worker invocation is capped at **50 subrequests** on the free plan. One request
per asset holds each invocation at ~6 regardless of watchlist size, and the
matrix renders **progressively** — a slow venue on one symbol cannot blank the
other rows. ~9 requests per refresh; ~900/day against a 100k/day limit.

### Why the Worker exists (do not remove it)
The browser cannot call the exchanges directly:
- Binance `futures/data/*` sends **no CORS headers**.
- Binance `fapi` is **geo-blocked** in Indonesia — and the Cloudflare edge
  nearest the user (Jakarta) hits the same block.

So the Worker runs on **Bybit (core) + OKX (extras)**, and Binance is recovered
two ways: opportunistically inside the Worker, and via a **hybrid client-side
fetch** in `src/binance-enrich.js` that uses the *user's own* network. Both
degrade silently to the Bybit/OKX baseline.

## Layout

```
index.html          markup shell only
styles.css
src/
  main.js           boot, manual refresh (opt-in timer), staleness, watchlist
  api.js            Worker client: fan-out, 8s timeout, per-asset failure
  matrix.js         Phase 1 grid + score chips
  detail.js         Phase 2 panel
  weather.js        BTC.D / USDT.D / TOTAL3 + manual ETF toggle
  format.js         per-symbol price / coin / percent formatters
  binance-enrich.js client-side Binance enrichment
worker/src/
  index.js          routing + CORS only — NO market logic
  pairs.js          allowlist + per-venue symbol mapping
  sources/          bybit · okx · binance · macro   (fetch + normalize)
  compute/          klines · ema · fvg · equilibrium · sweep · mode · walls
  score.js          §VII bias engine        ─┐ both exported,
  verdict.js        Phase 2 pullback health ─┘ NEVER summed
worker/test/        node --test suites (63 tests)
```

Run tests: `cd worker && npm test`. Deploy Worker: `cd worker && npx wrangler deploy`.
Page deploys itself via GitHub Pages — no build step.

### Two engines, one codebase — this is deliberate
`score.js` and `verdict.js` **give opposite signs on price-down + OI-down**:

| price ↓ + OI ↓ | |
|---|---|
| `score.js` (§VII bias) | `−1` bearish — *long flush* |
| `verdict.js` (Phase 2) | `ok` — *deleveraging, POI has better odds* |

Both are correct **for their own question**. Phase 1 asks "what is the bias?";
Phase 2 asks "is this pullback safe to enter?". They are rendered in separate,
separately-labelled blocks and must never be summed or averaged.
`worker/test/verdict.test.js` has a test that asserts this divergence on purpose —
if it fails because someone "fixed" the inconsistency, read the spec first.

The planned TradingView → Telegram worker must **import `verdict.js`**, not
reimplement it.

## Pairs
`DEFAULT_WATCHLIST` is playbook §II's fixed eight: BTC, ETH, SOL, NEAR, SUI,
AVAX, LINK, ARB. `PAIRS` is wider (adds HYPE, WLD, RENDER, ZEC, ONDO, ASTER,
JTO, XRP, BNB, DOGE, ADA) because the trade journal shows real rotation into
coins outside §II. Override with `?watchlist=BTC,HYPE,...` (persisted to
`localStorage.ppd_watchlist`). All 19 bases verified present on both Bybit
linear and OKX SWAP (2026-08-19).

OI and wall sizes are in the **base coin**, so the page formats units per symbol
(thousands of BTC vs billions of DOGE).

## Scoring — playbook §VII is the authority

Per-asset **−5..+5**, one point per layer. `≥ +3` CLEAR TO LONG · `≤ −3` CLEAR TO
SHORT · `−2..+2` CHOPPY/RANGE.

| Layer | +1 | −1 | 0 |
|---|---|---|---|
| Spot ETF flow | `> +$50M` | `< −$50M` | flat / no data |
| Funding | `< 0%` | `> +0.015%` | otherwise |
| OI + price Δ (1h) | price ↑ + OI ↑ | price ↓ + OI ↓ | other |
| EMA34 (4H) | body close above | body close below | oscillating |
| Liquidity sweep | PDL swept + reclaimed | PDH swept + rejected | inside range |

Thresholds live in one place: `THRESHOLDS` in `worker/src/score.js`.

## Known limits and quirks (deliberate — don't "fix" without reason)

- **Every upstream needs a descriptive `User-Agent`.** Workers send none by
  default. CoinGecko answers `403 "Please add a descriptive User-Agent"`, and
  Farside 403s too. `UPSTREAM_HEADERS` in `worker/src/index.js` fixes both;
  `worker/test/upstream-headers.test.js` guards it.
- **Dominance is fetched CLIENT-SIDE, from the device — not the Worker.**
  *Every* free market-cap API rate-limits by IP, and Cloudflare's Worker egress
  IPs are shared across all Workers customers, so the quota is exhausted by
  strangers before we call: CoinGecko returns **429**, CoinPaprika **402**. Both
  answer 200 from an ordinary connection. Swapping vendors does not fix this —
  it was tried. `src/weather.js` fetches from the browser (CoinGecko, then
  CoinPaprika), which uses the *user's* IP, exactly like `binance-enrich.js`.
  This is only legitimate because **dominance is display-only**; anything that
  feeds the score must stay server-side. The Worker still attempts it as a
  last-resort fallback.
- **Upstream retries need backoff.** Eight asset requests fire at once, so a
  transient Bybit geo-403 hits several; retrying with zero delay just re-races
  the same congested moment. `fetcher()` backs off 120/350/800ms, which took a
  watchlist sweep from ~6/8 to 24/24 over three refreshes.
- **The ETF layer works, but only from the Worker.** Farside sits behind
  Cloudflare and 403s most clients — including a local `curl` — yet Worker
  egress passes. So layer 1 is live in production and cannot be verified from a
  dev machine. The header's `in/out/flat` toggle is a **fallback** for when the
  scrape breaks, sent back as `?etf=` so scoring stays server-side.
- **Upstream failures must never be swallowed silently.** A caught-to-null error
  hid both bugs above behind an empty weather widget for a full deploy.
  `fetchMacro` uses `allSettled` and surfaces reasons on `/macro?debug=1`.
- **The OI layer only scores 2 of 4 quadrants**, exactly as §VII specifies.
  Price-down + OI-up (*fresh shorts*) and price-up + OI-down (*short covering*)
  render as badges but score `0` rather than inventing signs the playbook never
  assigned.
- **ETF flow is a BTC-macro layer proxied onto alts**, tagged `proxy` in the UI.
  It never differentiates between assets. Inherent to the spec.
- **PDH/PDL day boundary is UTC**, not WIB — 7h off from the owner's local day.
- **The daily kline deliberately keeps its unclosed candle** (today's running
  high/low *is* the sweep). Every other series drops it.
- **EMA34 needs 200 bars.** The PRD said 50; that leaves only 16 bars past the
  SMA seed and the layer flips on noise.
- **FVG definitions in the PRD were inverted.** With oldest-first bars, bullish
  is `high[i-2] < low[i]`. `worker/test/fvg.test.js` guards this permanently.
- **Dominance (BTC.D / USDT.D / TOTAL3) is display-only** and must never enter
  the score.
- **Order book is shallow.** Even OKX `books-full` (~5000 levels) spans roughly
  ±0.5–1%. Walls are *immediate-book* liquidity and are spoofable — one
  confluence input, not a trigger. Deeper walls need a WS-maintained book.
- **Liquidations / heatmaps are intentionally absent** — no free source worth it.
- **Stale data greys the grid and shows a banner after 10 min.** Silently showing
  old prices as live is the worst failure this tool can have.
- **Refresh is MANUAL by default — nothing fetches until you press the button.**
  Not boot, not returning to the tab. One refresh = 1 macro + N asset requests
  (~32 upstream exchange calls at N=8), and the binding constraint is never
  Cloudflare (auto at 5 min over an 8h day is ~860 requests, under 1% of the
  100k/day free limit) — it is the exchanges. `?auto=on` (persisted as
  `ppd_auto`) restores the 5-minute timer and the refetch-on-return; under it,
  returning to the tab refetches **only if data is older than `MIN_REFETCH_MS`
  (60s)**, because an unguarded `visibilitychange` reload turned ordinary
  tab-switching into a burst generator — precisely what trips Bybit's geo-block
  and OKX's rate limit. The staleness banner works in both modes.
- **A manual ETF override expires after 24h** (`ETF_TTL_MS` in
  `src/weather.js`). It is a reading of *today's* flow, but it is persisted and
  relayed to every asset on every refresh — left forever it silently pins layer
  1 of the whole watchlist to the same ±1 for weeks. The button shows its age.
- **Client concurrency is capped at 3** (`POOL` in `src/api.js`). Firing all 8 at
  once made ~3 fail together, because the burst tripped OKX's limit at the same
  moment Bybit's CDN geo-blocked — removing the fallback for exactly the rows
  that needed it.

## Docs
`docs/reading-the-dashboard.html` is the **reader's guide** — a plain-language
explanation of every number on screen, written for someone who had no part in
building this. Keep it in sync when a badge, chip or score layer changes; it is
the artifact shared with anyone who asks "what am I looking at?".

## Roadmap
- Playbook §III 5-pillar gate (needs ≥4/5 to qualify). Pillars 1, 2 and 5 are
  already derivable from `mode`, `equilibrium` and `sweep`; 3 and 4 need manual
  checkboxes.
- TradingView alert webhook → Worker → Telegram push (reuse `verdict.js`).
- Optional: Deribit options skew/gamma as another free confluence layer.
