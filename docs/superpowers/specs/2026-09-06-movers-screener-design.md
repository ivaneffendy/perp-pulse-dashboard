# Movers tab — awareness-only screener design

Date: 2026-09-06
Status: approved for planning

## The question this answers

Phase 1 today only ever looks at whatever is already in the watchlist. It has
no way to notice a coin that is not being watched at all — ARB up 22% in a day,
or ASTER's pump, both went unseen because neither was pinned and nobody in the
trading group happened to mention them in time to use the move.

This adds a second, disposable question the dashboard can answer: *of
everything trading right now, what actually moved unusually today?* — so a real
move is visible even when it happens on a coin never added to the list.

## Origin and a documented constraint

The request referenced "Kevin Sailly's" alt-screening approach. His actual SOP,
recorded in the (private, sibling) trading-vault at `mentors/kevin-sailly.md`:
(1) set BTC daily bias, (2) read OTHERS.D vs TOTAL3 to check whether alts are
being bid at all, (3) find alts outperforming BTC that day.

That vault already has a verdict on this, in `playbook/pending-revisions.md`
R7's 2026-09-02 addendum:

- The dynamic-screening model itself was **considered and not adopted** as a
  replacement for the fixed watchlist — continuous screening is a screen-time
  commitment the operator's 9-to-5 does not budget for, which conflicts with
  §II's whole shape.
- The specific pattern of trading small/micro-cap alts on relative strength has
  an **already-measured record on the operator's own journal**: 17 off-list
  trades in this style (ASTER, JTO, ONDO, WLD, ZEC, HYPE, RENDER, BNB) returned
  −13.79R, vs +0.60R staying on-list.

Both objections are about *trading* off a continuous screen, not about a
once-per-refresh, zero-extra-screen-time display. This feature is scoped
deliberately to stay on the right side of that line — see Non-goals.

## Non-goals

- **Not a score input.** Never enters `score.js`, `verdict.js`, `absorption.js`
  or `regime.js` — same discipline that already keeps dominance and regime out
  of scoring. A source-inspection test guards this permanently (see Testing).
- **Not clickable.** No row opens the detail panel, computes a bias score, or
  offers any Phase 2 read. Full parity with the existing lookup flow was
  explicitly considered and rejected during design — it is the shape of thing
  R7 is trying to make binding-off-limits, just moved one click closer.
- **Not a replacement for the fixed watchlist**, and not on any auto-refresh
  loop of its own. It rides the existing manual Refresh press, at whatever
  cadence (manual or `?auto=on`) the rest of the page already uses.
- **Not evidence for or against R7.** Whether this tool changes any trading
  behavior is a journal question, not a dashboard one — the existing
  `external_source=kevin-sailly` tagging in `journal/trades.csv` already
  answers that, independently of anything built here.

## Architecture

One new Worker route, costing exactly the same **one** upstream call whether it
scans 10 symbols or the whole market — this is the key difference from every
other route in this codebase:

```
Refresh press ── load() ──▶ GET /movers
                              │
                              ├─ Bybit  ALL linear tickers ×1   (primary)
                              └─ OKX    ALL SWAP tickers ×1     (fallback)
                                   │
                                   ▼
                            compute/movers.js
                                   │
                                   ▼
                     { ts, source, items: [...] }
```

### Why one call regardless of universe size

`/asset` fans out per-symbol because each symbol needs its own klines/OI/book
calls. Bybit's `tickers` endpoint is different in kind: one request returns
every linear perpetual's 24h stats (price, % change, volume) at once. Scanning
the full ~500-800 symbol market costs the same single call as scanning 10 — the
only variable is response size, and sorting a few hundred JSON objects in a
Worker is negligible. This is why the design does not restrict to `PAIRS`: the
known 19-coin set already includes ARB and ASTER, so restricting to it would
have missed the actual motivating cases.

### OKX fallback

Mirrors the existing primary/fallback shape everywhere else in the codebase —
list-vs-list instead of per-symbol. Bybit's CDN geo-blocks the Cloudflare edge
intermittently; a `/movers` with no fallback would fail exactly when the rest
of the dashboard is already degraded.

## The compute module

New pure module, `worker/src/compute/movers.js`, no I/O, matching every other
module under `compute/`.

### Input

The raw ticker array from either venue, normalized to a common shape:
`{ base, pct24h, turnover24h }`.

### Ranking

```js
export const MOVERS = {
  floor: 10_000_000,  // USD 24h turnover — provisional, see Known limits
  top: 8,
};

export function rankMovers(tickers, opts = MOVERS) {
  const btc = tickers.find((t) => t.base === 'BTC');
  return tickers
    .filter((t) => t.base !== 'BTC' && t.turnover24h >= opts.floor)
    .map((t) => ({ ...t, rel: t.pct24h - (btc?.pct24h ?? 0) }))
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel))
    .slice(0, opts.top);
}
```

- BTC is excluded from the output (its relative strength against itself is
  always 0 and not informative), but its `pct24h` is still needed as the
  baseline, so the source layer must pass it into `rankMovers` rather than
  filtering it out beforehand.
- Ranked by **absolute** relative strength, so a coin unusually lagging BTC
  surfaces too, not only gainers.
- No dependency on `PAIRS`, `WATCHLIST`, or anything pinned — a coin already on
  the matrix can still appear here if it is moving unusually.

## API

`GET /movers`

```json
{
  "ts": 1787600000000,
  "source": "Bybit linear",
  "items": [
    { "base": "ARB", "pct24h": 22.37, "rel": 22.26, "turnover24h": 184000000 },
    { "base": "ASTER", "pct24h": 18.90, "rel": 18.79, "turnover24h": 96000000 }
  ]
}
```

No symbol-specific fields (funding, OI, EMA, sweep) — this is deliberately
thinner than `/asset`, because a richer payload is the first thing that invites
a richer, scoreable UI later.

## Frontend

### Page structure

A tab bar (`Matrix` / `Movers`) after the weather strip. Shared across both
tabs: header, weather bar (BTC.D/USDT.D/TOTAL3 doubles as Kevin's own
rotation-check signal, so it is useful context for Movers too), staleness/error
banner, footer. Matrix-only, hidden under the Movers tab: watchlist input bar,
`#matrix`, the detail panel, the legend.

Switching tabs is a pure visibility toggle (`hidden` attribute) — it never
fetches. `/movers` is fetched once per `load()`, same as macro/dominance, so
whichever tab is open already has current data.

### Movers view

Plain inert rows in a new `#movers-view` section: symbol, 24h % change,
relative strength vs BTC (signed), 24h volume. No click handler, no
background/badge implying a score. A short label above the list makes the
"awareness, not a signal" framing explicit in the UI copy itself, not just in
code comments.

### Failure handling

Matches how `weather.js` already handles a failed macro fetch: `/movers`
failing renders "Movers unavailable" inline inside `#movers-view`, and does
**not** trigger the page-wide `err` banner — that stays reserved for the core
matrix fetch, its existing meaning. One upstream miss should not imply the
whole proxy is unreachable.

## Testing

`worker/test/movers.test.js`, `node --test`, matching the existing suites. The
module is pure, so every ranking/filtering case is a synthetic ticker array:

- filters out anything below `floor`
- excludes BTC from the output, but still uses its `pct24h` as baseline
- ranks by absolute relative strength, not raw `pct24h` (a big loser vs BTC
  outranks a small gainer)
- slices to `top`
- empty/all-filtered input returns `[]`, not a throw
- missing BTC in the input (should not happen, but the venue response is not
  ours to guarantee) — baseline defaults to 0 rather than throwing

A route-level test asserts `/movers` returns the documented shape and that the
OKX fallback engages when the Bybit fetch throws.

**Guard test, matching the existing `regime.test.js` precedent:** by source
inspection, assert `score.js`, `verdict.js`, `absorption.js`, and `regime.js`
never mention `movers` or `rankMovers`. This is the enforced version of the
Non-goals section above — a future session cannot "helpfully" wire this into
scoring without a test failing first.

## Documentation

`CLAUDE.md`: add `/movers` to the architecture diagram and Layout section;
document the awareness-only constraint next to the existing "Four questions,
one codebase" section, framed like dominance (display-only) rather than as a
fifth parallel question, since it is not scored and not per-asset. Add a
Known-limits bullet recording the floor as untuned.

`docs/reading-the-dashboard.html` gains a short entry explaining the Movers tab
in the same plain language as the rest of that guide.

## Known limits, recorded deliberately

- **The `$10M` turnover floor is a first guess, not tuned against data.** It
  exists to exclude illiquid/leveraged-token noise from dominating a
  percentage-based ranking. Expect at least one adjustment pass once real
  output is visible — same posture as `ABSORPTION`'s thresholds when that
  shipped.
- **Relative strength vs BTC is a same-day snapshot, not a trend.** It reports
  that a coin moved unusually against BTC over the last 24h, not that the move
  is continuing or reversing. Same "coincident, not leading" caveat as
  `regime.js`.
- **Turnover is venue-local**, same caveat as the existing RVOL work — Bybit's
  (or OKX's) own book, not aggregate market volume.
- **This does not implement Kevin's rotation-check step.** The weather bar
  already shows TOTAL3; reading it as "are alts being bid at all" is left to
  the trader, not automated here.
