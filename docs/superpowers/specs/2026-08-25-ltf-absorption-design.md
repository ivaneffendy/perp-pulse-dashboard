# On-demand LTF absorption check — design

Date: 2026-08-25
Status: approved for planning

## The question this answers

Playbook §IV Step 2, marked **[CRITICAL]**, is the one confirmation the
dashboard has never been able to give:

> **Absorption (Valid):** the wick sweep is accompanied by a high volume spike —
> aggressive market orders absorbed by institutional limit orders.
> **Initiative (Invalidation):** price breaks the POI with strong body candles
> and high volume, no rejection wick. Cancel the limit order. This is a real
> breakout, not a sweep.

A TradingView alert fires at a mapped POI. Within the §II Step 3 window of 5–10
minutes the trader needs one read: **is this tap being absorbed, or is it
slicing through?**

## Non-goals

- **Not a score input.** This never enters `score.js`. §VII's table has no
  volume row, and inventing one repeats the mistake dominance was kept out of.
- **Not merged into `health`.** `verdict.js` answers a 1-hour positioning
  question from funding/OI/taker/book. This answers a 15-minute candle-mechanics
  question. Same discipline as `score.js` vs `verdict.js`: rendered in its own
  labelled block, never summed or averaged with either.
- **Not the full §IV trigger checklist.** Steps 1, 3 and 4 (LTF sweep, ChoCh
  body close, displacement FVG) are explicitly out of scope. Auto-detecting
  ChoCh and swing structure carries far more false-positive surface than the
  volume read, and can be layered on later if it earns its place.
- **Not automatic.** It must never join the matrix refresh loop — see below.

## Why on-demand, and why that is not just about cost

The freshness argument is stronger than the request-budget one. A 15m absorption
read is only meaningful in the minutes around the POI tap. Riding along with the
matrix refresh would routinely show a verdict computed *before* the alert fired,
which is worse than showing nothing — it invites acting on a stale read of the
one thing that is supposed to be live.

An explicit button guarantees the read is from the moment it is looked at.

## Architecture

A dedicated Worker route. Pressing the button costs exactly **one** upstream
call.

```
Detail panel  ── button press ──▶  GET /ltf?symbol=SOL
                                     │
                                     ├─ Bybit  15m klines ×40   (primary)
                                     └─ OKX    15m candles ×40  (fallback)
                                          │
                                          ▼
                                   compute/absorption.js
                                          │
                                          ▼
                              { cls, side, rvol, label, msg, bar }
```

### Why a separate route rather than `?ltf=1` on `/asset`

`/asset` always fetches core first — tickers, 4H klines ×200, daily klines, OI
history. Adding a param would pay four upstream calls to obtain the one that
matters, or require branching to skip core, which is most of the work of a
separate route anyway. A dedicated route also leaves the matrix path completely
untouched, so this cannot regress Phase 1.

It also gives the planned TradingView → Telegram worker a focused endpoint,
mirroring how `verdict.js` was written to be imported rather than reimplemented.

### Why not client-side

Bybit is reachable from the browser, so this *could* follow `binance-enrich.js`.
It should not: it would duplicate the classification logic in the page, breaking
the rule that anything feeding a trading decision has exactly one server-side
implementation, and the Telegram worker could not reuse it. `binance-enrich.js`
is justified only because Binance is geo-blocked from the edge; Bybit is not.

### OKX fallback is required, not optional

Bybit's CDN geo-blocks the Cloudflare edge intermittently — that is the entire
reason the `via OKX` provenance tag exists. A `/ltf` route with no fallback
would fail precisely when the rest of the dashboard is already degraded. OKX
serves `/api/v5/market/candles?instId=<inst>&bar=15m`, and the response carries
volume in the same position, so `normalizeKlines` absorbs the difference.

The response reports which venue served it, consistent with the provenance work
already shipped.

## The compute module

New pure module, `worker/src/compute/absorption.js`, with no I/O — matching
every other module under `compute/`.

### Input

15m bars, oldest-first, **with the forming candle kept**
(`normalizeKlines(..., dropUnclosed = false)`). This mirrors the daily sweep
candle: the tap being judged is happening right now, and dropping the in-progress
bar would hide the very thing the button was pressed to see. Every other series
in the codebase drops it; these two do not, deliberately.

### The forming-bar problem

Keeping the forming bar introduces two traps that the design must handle
explicitly, or the feature reads "quiet" at exactly the wrong moment:

1. **Volume is partial.** A 15m bar three minutes old holds roughly 20% of a
   normal bar's volume, so a naive RVOL reads low on every fresh tap.
   **Fix:** pro-rate by elapsed fraction of the interval.
   `rvol = v / (trailingAvg * max(elapsedFraction, MIN_ELAPSED))`.
   The floor prevents a division blow-up in the first seconds of a bar.

2. **Geometry is unstable.** A bar one minute old has `o ≈ c ≈ h ≈ l`; its
   wick-to-body ratio is noise.
   **Fix:** do not fixate on the newest bar. Evaluate the last
   `evalBars` (3) bars — forming included — and report the most decisive: the
   highest pro-rated RVOL among bars whose shape passes a threshold. Three 15m
   bars covers ~45 minutes, matching the alert-response window, and degrades
   gracefully when the newest bar is too young to read.

### The baseline excludes the bar being judged

For a bar at index `i`, the trailing average is taken over bars
`[i - lookback, i - 1]` — strictly *before* it, never including it. A spike
folded into its own baseline dilutes itself: the more violent the bar, the more
it raises the mean it is measured against, and the tamer it reads. Since only
the last bar can be forming and every baseline window ends before its own bar,
the partial forming volume can never contaminate a baseline either.

Each of the `evalBars` candidates therefore gets its own baseline window rather
than sharing one.

### Per-bar geometry

```
range      = h - l
body       = |c - o|
upperWick  = h - max(o, c)
lowerWick  = min(o, c) - l
```

Bars where `range === 0` are skipped rather than divided by.

### Classification

| Condition | Result |
|---|---|
| `rvol >= rvolHot` and `lowerWick/range >= wickDom` | `absorbed`, side `+1` — demand absorbed the sweep |
| `rvol >= rvolHot` and `upperWick/range >= wickDom` | `absorbed`, side `-1` — supply absorbed the sweep |
| `rvol >= rvolHot` and `body/range >= bodyDom` | `initiative`, side = `sign(c - o)` — real break, cancel the limit |
| otherwise | `quiet`, side `0` — no volume anomaly worth reading |

A bar cannot be both, and that is structural rather than a precedence rule:
`upperWick + body + lowerWick === range` always, so `wickDom + bodyDom > 1`
(0.55 + 0.60 = 1.15) makes the two conditions mutually exclusive by
construction. No tie-break is needed, and a test asserts the invariant so
future threshold tuning cannot silently reintroduce an overlap.

### Thresholds

One exported constant, mirroring `THRESHOLDS` in `score.js` so tuning has a
single home:

```js
export const ABSORPTION = {
  lookback:    20,    // bars in the trailing volume average
  evalBars:     3,    // most recent bars considered
  rvolHot:    1.8,    // "high volume spike"
  wickDom:   0.55,    // rejection wick share of range
  bodyDom:   0.60,    // body share of range (initiative)
  minElapsed: 0.15,   // floor on the forming bar's elapsed fraction
};
```

These are a starting point, not tuned against history. The spec records them as
provisional; the plan should expect at least one adjustment pass after live use.

## API

`GET /ltf?symbol=<base>`

```json
{
  "ts": 1787600000000,
  "symbol": "SOL",
  "source": "Bybit linear",
  "interval": "15m",
  "cls": "absorbed",
  "side": 1,
  "rvol": 2.41,
  "label": "Absorbed at the low",
  "msg": "15m bar on 2.4x average volume with a 62% lower wick, closing back inside — aggressive selling was met by resting bids. Consistent with §IV Step 2 absorption.",
  "bar": { "t": 1787599200000, "o": 99.1, "h": 99.4, "l": 97.8, "c": 99.2, "v": 41822, "forming": true }
}
```

`cls` is one of `absorbed` | `initiative` | `quiet` | `nodata`.

Symbol resolution reuses `resolvePair`, so `/ltf` inherits the existing
allowlist unchanged.

## Frontend

A button inside the detail panel, below the Pullback health block — Phase 2
territory, where the trader already is when an alert fires.

- Label: `Check 15m trigger`. Never fires on panel open; only on press.
- While in flight: disabled, `Checking…`.
- On success: renders a new labelled block, `LTF trigger (§IV Step 2)`, showing
  `label`, `msg`, the RVOL figure, and the serving venue.
- The block carries its own timestamp, because the whole point is freshness. A
  read older than `LTF_STALE_MS` (2 min) greys out and the button returns to
  `Check 15m trigger` so it is re-pressed rather than re-read.
- Re-pressing refetches. No caching in the page.
- Visually distinct from the health block, and separated by its own label, so
  the two are never read as one verdict.

Opening a different asset discards the block — an LTF read belongs to one
symbol and one moment.

## Error handling

Consistent with the codebase rule that upstream failures are never swallowed:

- Both venues unreachable → HTTP 502 with a `detail` naming both errors, and the
  panel shows the reason rather than an empty block.
- Fewer than `lookback + 1` bars returned (a thin or newly listed market) →
  `cls: "nodata"` with an explicit message. Never a fabricated RVOL. Between
  `lookback + 1` and `lookback + evalBars` bars, only the candidates that have a
  complete baseline window are evaluated, rather than failing outright.
- Trailing average volume of zero → `nodata`, not a division by zero.

## Testing

`worker/test/absorption.test.js`, `node --test`, matching the existing suites.
The module is pure, so every case is a synthetic bar array:

- bullish absorption — high volume, dominant lower wick → `absorbed`, side `+1`
- bearish absorption — high volume, dominant upper wick → `absorbed`, side `-1`
- initiative up / down — high volume, dominant body → `initiative`, correct sign
- high volume, indecisive shape (neither threshold met) → `quiet`
- normal volume with a big wick → `quiet` (volume gates the read, not shape)
- forming-bar pro-rating: a young bar with modest raw volume classifies hot once
  pro-rated, and the same bar without pro-rating would not
- `minElapsed` floor: a bar seconds old does not produce an infinite RVOL
- most-decisive selection: given three qualifying bars, the highest RVOL wins
- `range === 0` bar is skipped, not divided by
- fewer than `lookback + 1` bars → `nodata`
- zero trailing volume → `nodata`

A route-level test asserts `/ltf` returns the documented shape and that the OKX
fallback engages when the Bybit fetch throws.

## Documentation

`docs/reading-the-dashboard.html` gains an entry for the LTF block and the two
verdicts, in the plain language that guide uses. `CLAUDE.md` gains a note under
the layout map and a known-limits bullet recording that the forming bar is kept
deliberately here and in the daily sweep, and nowhere else.

## Known limits, recorded deliberately

- **Volume is venue-local.** Bybit's 15m volume is Bybit's book only, not
  aggregate market volume. A spike is relative to that venue's own recent
  history, which is what RVOL measures — but it is not proof of market-wide
  participation.
- **A single 15m bar is a coarse instrument for a §IV read.** The playbook's
  Step 2 lives at the moment of the wick on 15m *or 5m*; this reads 15m only, by
  choice, because 5m volume and single wicks are materially noisier. If live use
  shows the 15m read arriving too late, adding 5m is a small change to an
  already-parameterised module.
- **Absorption is necessary, not sufficient.** §IV requires Steps 3 and 4 (ChoCh
  and displacement FVG) before an entry qualifies, and those remain manual. The
  UI copy must not imply this button alone validates a trade.
