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
  ├─ GET /asset?symbol=X&deep=1 ─▶ Worker ─▶ + OKX + Binance + Bybit book (~14)
  │    └─ Binance fapi DIRECT from the device (hybrid client-side enrichment)
  ├─ GET /movers              ─▶ Worker ─▶ Bybit ALL tickers (1 call, OKX fallback)
  │       └─ awareness-only — rides the same Refresh press, never scored
  └─ GET /ltf?symbol=X       ─▶ Worker ─▶ Bybit 15m klines (1 call, OKX fallback)
       └─ ON DEMAND ONLY — a button press, never the refresh loop
```

### Why fan out instead of one `/matrix` call
A Worker invocation is capped at **50 subrequests** on the free plan. One request
per asset holds each invocation at ~7 regardless of watchlist size, and the
matrix renders **progressively** — a slow venue on one symbol cannot blank the
other rows. ~10 requests per refresh; ~1000/day against a 100k/day limit.

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
  main.js           boot, manual refresh (opt-in timer), staleness, watchlist, tabs
  api.js            Worker client: fan-out, 8s timeout, per-asset failure
  matrix.js         Phase 1 grid + score chips
  detail.js         Phase 2 panel
  movers.js         Movers tab render — awareness-only, no score, no click
  weather.js        BTC.D / USDT.D / TOTAL3 + manual ETF toggle
  format.js         per-symbol price / coin / percent formatters
  binance-enrich.js client-side Binance enrichment
worker/src/
  index.js          routing + CORS only — NO market logic
  pairs.js          allowlist + per-venue symbol mapping
  sources/          bybit · okx · binance · macro   (fetch + normalize)
  compute/          klines · ema · fvg · equilibrium · sweep · mode · walls
                    · absorption  (§IV Step 2, /ltf only) · regime · movers
  score.js          §VII bias engine        ─┐ four separate questions,
  verdict.js        Phase 2 pullback health  │ NEVER summed or averaged
  compute/absorption.js  §IV Step 2 LTF read ─┘
worker/test/        node --test suites (128 tests)
```

Run tests: `cd worker && npm test`. Deploy Worker: `cd worker && npx wrangler deploy`.
Page deploys itself via GitHub Pages — no build step.

### Four questions, one codebase — this is deliberate
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

`compute/regime.js` is the **fourth** question: *is the tape behaving abnormally
right now?* It is rendered on its own and never enters the other three — §VII
assigns no volatility row, and `worker/test/regime.test.js` asserts by source
inspection that `score.js`, `verdict.js` and `absorption.js` never mention it.

`compute/movers.js` sits OUTSIDE this four-question framework entirely — it is
not per-asset and not scored, closer to how dominance is display-only. It
ranks the whole market by relative strength vs BTC for the awareness-only
Movers tab, and `worker/test/movers.test.js` asserts by source inspection that
`score.js`, `verdict.js`, `absorption.js` and `regime.js` never mention it.
This boundary is not just style: `docs/superpowers/specs/2026-09-06-movers-screener-design.md`
records a documented, data-backed reason from the trading-vault (R7's Kevin
Sailly addendum measured this exact screening pattern, used as a TRADING
method, at -13.79R). Read that spec before adding any score, verdict, or
click-through to a mover row.

## Pairs
`DEFAULT_WATCHLIST` is just the always-on anchors: BTC, ETH, SOL. The rest of
playbook §II's eight (NEAR, SUI, AVAX, LINK, ARB) still resolve and are still
`known`, they just aren't pre-loaded — type the ticker to pull one in. `PAIRS`
is wider still (adds HYPE, WLD, RENDER, ZEC, ONDO, ASTER, JTO, XRP, BNB, DOGE,
ADA) because the trade journal shows real rotation into coins outside §II. All
19 bases verified present on both Bybit linear and OKX SWAP (2026-08-19).

**`PAIRS` is no longer a gate — it is the verified set.** Any base matching
`VALID_BASE` (`/^[A-Z0-9]{2,15}$/`) resolves, tagged `known: false` and badged
`unverified` in the UI. The regex, not the list, is what keeps arbitrary
`?symbol=` strings out of upstream URLs, and it is deliberately narrow: no
separators or punctuation, so nothing can append a query parameter or traverse
a path. A rejected symbol gets **400**, never a silent substitution — serving
BTC's numbers under a mistyped name is the one failure a user-typed field must
not produce. `worker/test/pairs.test.js` guards the rejection list.

Derived symbols can be wrong even when they resolve: Bybit lists PEPE as
`1000PEPEUSDT`, so `PEPEUSDT` 404s there and OKX serves the row instead. That
is exactly what `unverified` warns about. A base neither venue lists returns a
plain `Not listed on Bybit or OKX`, with the raw upstream text moved to
`upstream` so the page shows the readable line rather than a TypeError.

The watchlist is editable from the page: type a ticker to look it up (an
unpinned, dashed row held in memory — survives Refresh, not a reload), `+ pin`
to persist it to `localStorage.ppd_watchlist`, `✕` to remove any row including
the anchors, and Reset to restore BTC/ETH/SOL. `?watchlist=BTC,HYPE,...` still
works.

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
- **Layer 3 scores off the last CLOSED 1H bar's own return, not the live
  rolling one.** `price.chg1h` (the "1h%" badge next to price, and the figure
  `verdict()` reads) is a trailing-60min number that keeps moving as the clock
  does. `oiD1h` is bucketed to the venue's clock-hour boundary and does not.
  Feeding the rolling figure into layer 3 against the bucketed one drifts the
  two windows up to ~55min apart near the top of the hour — CONFIRMED
  2026-09-05 against live Bybit data. Layer 3 alone uses
  `lastClosedBarChangePct(c.bars1h)` in `index.js`, which shares oiD1h's exact
  window; the display badge and verdict() keep the rolling figure, since a
  "1h%" that only updates once an hour would read stale on the one thing
  meant to look live.
- **ETF flow is a BTC-macro layer proxied onto alts**, tagged `proxy` in the UI.
  It never differentiates between assets. Inherent to the spec.
- **PDH/PDL day boundary is UTC on both venues**, not WIB — 7h off from the
  owner's local day. Neither venue's native daily-candle endpoint is fetched
  directly anymore; see the next two bullets for why.
- **Bybit's `interval=D` daily candles are UTC-midnight-aligned**, so its
  PDH/PDL is derived from the 1H series instead purely to save a call: every
  asset already fetches 200 hourly bars for the volatility-regime baseline
  (regime.js), and `dailyFromHourly()` (`worker/src/compute/klines.js`)
  re-normalizes that same payload with the forming hour kept, bucketed by
  UTC calendar day.
- **OKX's `bar=1D` candles bucket at UTC+8 (00:00 Singapore) instead** —
  verified across BTC/ETH/SOL over 5 days, every row opens at
  `16:00:00.000Z`. Fetching it directly (as the Worker used to) silently gave
  an OKX-served row a PDH/PDL for a different calendar day than a
  Bybit-served row at the same moment, invisible in the UI since both render
  through the same `sweep` badge. OKX's own hourly bars ARE UTC-aligned, so
  `okxCore()` now derives `today`/`prevDay` via the same `dailyFromHourly()`,
  never from `bar=1D` — matching Bybit's boundary, and costing one fewer
  subrequest than the dedicated daily fetch it replaces.
- **Two series deliberately keep their unclosed candle** — the daily (today's
  running high/low *is* the sweep) and the 15m LTF read (the tap being judged is
  happening right now). Every other series drops it. Keeping it forces the
  forming-bar correction below.
- **The 15m absorption read pro-rates the forming bar's volume.** A bar three
  minutes into its fifteen holds ~20% of a normal bar, so a raw RVOL reads
  "quiet" at exactly the moment the button was pressed. `absorption()` divides
  by the elapsed fraction, floored at `minElapsed` so a seconds-old bar cannot
  produce an infinite ratio. Its trailing baseline also **excludes the bar being
  judged** — a spike folded into its own average dilutes itself.
- **`/ltf` is on-demand and must stay that way.** Not on the refresh loop, not
  on detail-panel open. A 15m absorption read is only meaningful in the minutes
  around the POI tap, so a stale one is worse than none — it invites acting on a
  dead read of the one thing that is supposed to be live. The page greys the
  block after 2 minutes for the same reason.
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
- **Which venue served a row is shown, because the fallback is not equivalent.**
  Bybit is primary and OKX takes over when Bybit's CDN geo-blocks the edge — but
  the two disagree on funding, OI and candles, so an OKX-served row is scored off
  different numbers. `src/matrix.js` tags it `via OKX` (dashed, styled as
  provenance rather than a signal); the detail panel names the venue and shows
  `oi.source` separately, since Bybit's OI endpoint fails on its own and gets
  patched from OKX even on Bybit-served rows.
- **Stale data greys the grid and shows a banner after 10 min.** Silently showing
  old prices as live is the worst failure this tool can have.
- **Refresh is MANUAL by default — nothing fetches until you press the button.**
  Not boot, not returning to the tab. One refresh = 1 macro + 1 movers + N
  asset requests (~33 upstream exchange calls at N=8), and the binding
  constraint is never Cloudflare (auto at 5 min over an 8h day is ~860
  requests, under 1% of the 100k/day free limit) — it is the exchanges.
  `?auto=on` (persisted as
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
- **The regime baseline is ~8 days, not 30.** 200 x 1H is what the OKX fallback
  serves in one call, and both venues must serve the same shape. A *sustained*
  high-volatility regime renormalises within about a week and the chip goes
  quiet. It detects transitions, not levels.
- **The regime read is coincident, not leading.** It reports that the tape IS
  disturbed, never that it is about to be — on the largest cascade in the study
  window it ranked in the low 60s at the opening bar and reached the top only
  three hours later. Do not describe it as a warning.
- **`vol` is drawn only at/above the 90th percentile, and 90 is a DISPLAY cut.**
  It hides a chip; no rule keys off it. The full percentile is always in
  `signals.regime.pct`.
- **The Movers tab's `$10M` turnover floor is a first guess, untuned against
  data** — see `MOVERS` in `worker/src/compute/movers.js`. It is
  awareness-only: no score, no click-through, and a permanent test guards it
  out of the four scoring engines. Do not wire it into `score.js` without
  re-reading `docs/superpowers/specs/2026-09-06-movers-screener-design.md`
  first — that boundary exists because of a measured, not theoretical, R7
  finding.
- **Movers is a same-day snapshot, not a trend — coincident, same caveat as
  `regime.js`.** It reports that a coin moved unusually against BTC over the
  last 24h, never that the move is continuing or reversing. Turnover is also
  venue-local (Bybit's or OKX's own book), the same caveat the RVOL work
  already carries. It also does not implement Kevin Sailly's rotation-check
  step (OTHERS.D vs TOTAL3, "are alts being bid at all") — the weather bar
  already shows TOTAL3, and reading it that way is left to the trader rather
  than automated here.

## Docs
The **authoritative trading playbook** — the SMC/derivatives method this
dashboard exists to serve — lives in the private sibling repo
`../trading-vault/playbook.md` (github.com/ivaneffendy/trading-vault, private).
It is not committed here: it contains personal risk/journal detail that has no
reason to be public, unlike this repo. Where it and any PRD, spec or
implementation disagree, the playbook wins. It's edited primarily in claude.ai
chat and synced back to that repo periodically — if the sibling repo isn't
cloned locally, ask before assuming any playbook detail.

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
