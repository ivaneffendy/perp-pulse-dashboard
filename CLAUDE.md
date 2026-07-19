# perp-pulse-dashboard

A personal, mobile-first **BTC perps confluence dashboard**. It is a quick
"read the tape at my POI" tool — **not** a trading bot and not an alerting
system. The owner is a discretionary crypto trader who marks POIs / market
structure and waits for confirmation before entry. When a TradingView alert
fires and price reaches a POI, they open this on their phone for one extra
confluence check: *is this pullback healthy (deleveraging) or risky (fresh
shorts / aggressive selling)?* before committing to an entry.

Owner is a software engineer, so code work is fine.

## Architecture

```
Phone browser
  → GitHub Pages          static page (index.html)
       → Cloudflare Worker  (worker/) — CORE data. Fetches Bybit + OKX
       │                     server-side, computes the verdict, returns JSON.
       │      → Bybit / OKX public REST   (reachable from the edge)
       │      → Binance fapi              (OPPORTUNISTIC — usually geo-blocked)
       └→ Binance fapi DIRECT (hybrid enrichment, client-side)
              Runs from the USER's device. On phone/VPN it reaches Binance and
              enriches taker + top-trader L/S + OI; on blocked networks it
              times out silently and the OKX/Bybit baseline stands.
```

### Regional reality (important)
Binance (`fapi.binance.com`) is **geo-blocked in Indonesia**, and the Cloudflare
edge nearest the user (Jakarta) hits the same block — so the Worker cannot rely
on Binance. The Worker therefore runs on **Bybit (core) + OKX (extras)**. Binance
is recovered two ways: (1) opportunistically inside the Worker if ever reachable,
and (2) a **hybrid client-side fetch** in `index.html` that uses the *user's own*
network (phone/VPN can reach Binance even when the edge can't). Both degrade
gracefully to the OKX/Bybit baseline.

- **`index.html`** — single-file dashboard. Pure renderer: it fetches the
  Worker and paints the payload. It contains **no** market logic. Deployed via
  GitHub Pages. Configure the Worker URL via `?api=<url>` (persisted to
  `localStorage` as `ppd_api`) or by hardcoding `WORKER_URL`.
- **`worker/`** — Cloudflare Worker (`wrangler.toml` + `src/index.js`). Stateless
  read-through proxy. This is where **all** data-fetching and the `verdict()`
  logic live. Deploy with `npx wrangler deploy` from `worker/`.

### Why the Worker exists (do not remove it)
The browser cannot call the exchanges directly:
- Binance `futures/data/*` endpoints send **no CORS headers**.
- Binance `fapi` is **geo-blocked** in some regions.
The Worker sidesteps both — the fetch happens at Cloudflare's edge, and it
returns permissive CORS. The page only ever talks to the Worker.

### Single source of truth
`verdict()` lives **only** in the Worker. When the planned TradingView →
Telegram push worker is built, it must reuse that same `verdict()` — do not
duplicate the read logic into the page or a second worker. Keep it shared.

## Data scope (v1) — all free, all snapshot

| Metric | Source | Notes |
|--------|--------|-------|
| Price + 1h/4h/24h change | Binance (Bybit fallback) | mark price |
| Funding rate + next funding | exchange | annualized on the client |
| Open interest + 1h/4h Δ | Binance `openInterestHist` | delta is Binance-only (deepest venue, good directional proxy) |
| **Aggregated OI (BTC)** | Binance + Bybit + OKX summed | USDT-margined perps only; a dead venue just drops out |
| Taker buy/sell, top-trader L/S | Binance `futures/data/*` | Binance-only; `null` on Bybit fallback → shown as `n/a` |
| **Order-book walls** | OKX `books-full` (~5000 lvl), Bybit fallback | band+significance: nearest *significant* cluster (the gap) + heaviest (magnet) per side, `coveredPct`, imbalance |

### Known limits / quirks (deliberate, don't "fix" without reason)
- **Order book is shallow.** Even OKX `books-full` (~5000 levels) only spans
  roughly ±0.5–1% around price. So walls = *immediate-book* liquidity, and a
  side with no outlier bin is reported as "smooth" rather than inventing a
  near-mid wall. `book.*.coveredPct` reports how far the snapshot actually
  reached. Deeper walls (±2%+) need a WS-maintained book = persistent recorder
  (out of scope). `computeWalls` drops the innermost bin (that's the spread) and
  only calls a bin a wall if it's ≥3× the median depth AND ≥15% of side volume.
- **Walls are spoofable.** Treat as "liquidity sitting here right now," one
  confluence input — not a trigger.
- **Liquidations / liquidation heatmaps are intentionally absent.** Binance's
  free `forceOrder` stream is throttled/partial; aggregated liq + heatmaps
  (Coinglass / mmt.gg) are paid-only with no free equivalent. Decided not worth
  it for a confluence check.
- **OI delta is Binance-only**, not aggregated (aggregating deltas needs history
  from all venues). The aggregate OI *level* is summed; the *direction* comes
  from Binance.

## Verdict thresholds (in `worker/src/index.js`, tune to taste)
- price move significant: `|chg1h| > 0.15%`
- OI move significant: `|oiD1h| > 0.25%`
- funding: negative `<= -0.01%` (squeeze fuel) / elevated `>= 0.02%` (crowded longs)
- taker: `< 0.9` sellers hitting / `> 1.1` buyers lifting
- Core read = price direction × OI direction:
  down+OI down = deleveraging (ok) · down+OI up = fresh shorts (risk) ·
  up+OI up = fresh longs (ok) · up+OI down = short covering (mixed)

## Roadmap (not yet built)
- TradingView alert webhook → Cloudflare Worker → Telegram push (reuse `verdict()`).
- Optional: Deribit options skew/gamma as an extra free confluence layer.
