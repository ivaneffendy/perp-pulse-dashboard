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
  └─ GET /ltf?symbol=X       ─▶ Worker ─▶ Bybit 15m klines (1 call, OKX fallback)
       └─ ON DEMAND ONLY — a button press, never the refresh loop
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
                    · absorption  (§IV Step 2, /ltf only)
  score.js          §VII bias engine        ─┐ three separate questions,
  verdict.js        Phase 2 pullback health  │ NEVER summed or averaged
  compute/absorption.js  §IV Step 2 LTF read ─┘
worker/test/        node --test suites (88 tests)
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
coins outside §II. All 19 bases verified present on both Bybit linear and OKX
SWAP (2026-08-19).

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
the §II eight, and Reset to restore them. `?watchlist=BTC,HYPE,...` still works.

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
