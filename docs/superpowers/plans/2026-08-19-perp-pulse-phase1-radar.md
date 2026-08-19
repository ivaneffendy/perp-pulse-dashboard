# Perp Pulse Phase 1 Radar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-asset Phase 1 pre-market radar (playbook §VII, −5..+5 bias score) to the Perp Pulse Dashboard, keeping the existing single-pair view as the Phase 2 detail panel.

**Architecture:** All market logic stays in the Cloudflare Worker (the browser cannot reach Binance from Indonesia and `futures/data/*` sends no CORS headers). The Worker is split into thin HTTP routing, per-venue `sources/`, and a pure `compute/` layer of testable functions. The page fans out one Worker request per watchlist asset in parallel so each Worker invocation stays ~4 upstream calls and the matrix renders progressively.

**Tech Stack:** Vanilla ES modules, no build step. Cloudflare Workers (ESM). `node --test` (Node 22, no framework). GitHub Pages for the static page.

**Spec:** `docs/superpowers/specs/2026-08-19-perp-pulse-rebuild-design.md`
**Branch:** `rebuild/phase-1-radar`

## Global Constraints

- **Never remove the Worker.** Binance `fapi` is geo-blocked from Indonesia and the Jakarta CF edge; `futures/data/*` sends no CORS headers. Reject the PRD's "Zero Backend" clause.
- **`verdict()` is the single source of truth for Phase 2 health** and must remain reusable by the future TradingView→Telegram worker. Never duplicate it into the page.
- **The §VII bias score and `verdict()` are never summed, averaged, or shown on the same line.** They answer different questions and give opposite signs on price-down + OI-down.
- **BTC.D / USDT.D / TOTAL3 never enter the score.** Display-only.
- **All kline arrays are normalized to oldest-first with the in-progress candle dropped** — except the daily pair used for PDH/PDL, which needs today's unclosed candle.
- **`compute/*` modules are pure**: no `fetch`, no `Date.now()` defaults read from ambient state, no config imports. Every clock value is an argument.
- Score thresholds live in one exported `THRESHOLDS` object, never inlined.
- Commit after every task. No Claude/Co-Authored-By trailer in commit messages.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/package.json` | ESM flag + `test` / `deploy` scripts |
| `worker/src/index.js` | Routing, CORS, response shaping. **No market logic.** |
| `worker/src/pairs.js` | Symbol allowlist + per-venue ID mapping |
| `worker/src/compute/klines.js` | Normalize venue kline tuples → oldest-first numeric bars |
| `worker/src/compute/ema.js` | EMA series + §VII layer-4 alignment |
| `worker/src/compute/equilibrium.js` | 50% equilibrium, discount/premium, swing distances |
| `worker/src/compute/fvg.js` | FVG detection + mitigation + nearest unmitigated |
| `worker/src/compute/sweep.js` | PDH/PDL swept-and-reclaimed state |
| `worker/src/compute/mode.js` | TREND vs RANGE via fractal swings + BOS |
| `worker/src/compute/walls.js` | Order-book walls (moved verbatim from current `index.js`) |
| `worker/src/score.js` | §VII 5-layer bias engine |
| `worker/src/verdict.js` | Phase 2 pullback health (moved from current `index.js`) |
| `worker/src/sources/bybit.js` | Core venue: price, funding, OI, klines, book |
| `worker/src/sources/okx.js` | Taker, account L/S, OI, `books-full` |
| `worker/src/sources/binance.js` | Opportunistic OI / taker / top-trader L/S |
| `worker/src/sources/macro.js` | CoinGecko dominance + spot ETF flows |
| `worker/test/*.test.js` | `node --test` suites, one per compute module |
| `index.html` | Markup shell only |
| `styles.css` | All styling |
| `src/format.js` | Price / coin / percent formatters |
| `src/api.js` | Worker client: fan-out, timeouts, partial failure |
| `src/matrix.js` | Phase 1 grid render |
| `src/detail.js` | Phase 2 panel render |
| `src/weather.js` | BTC.D / USDT.D / TOTAL3 widget |
| `src/binance-enrich.js` | Client-side Binance enrichment (extracted from current page) |
| `src/main.js` | Boot, refresh loop, visibility pause, staleness, watchlist state |

---

## Task 1: Test harness and kline normalization

**Files:**
- Create: `worker/package.json`
- Create: `worker/src/compute/klines.js`
- Test: `worker/test/klines.test.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `normalizeKlines(list, intervalMs, now, dropUnclosed = true) -> Bar[]`
    where `Bar = { t:number, o:number, h:number, l:number, c:number, v:number }`, oldest-first
  - `INTERVAL_4H: number`, `INTERVAL_1D: number`

- [ ] **Step 1: Create the package manifest**

`worker/package.json`:

```json
{
  "name": "perp-pulse-data",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "deploy": "wrangler deploy"
  }
}
```

- [ ] **Step 2: Write the failing test**

`worker/test/klines.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKlines, INTERVAL_4H } from '../src/compute/klines.js';

// Bybit rows are [startTime, open, high, low, close, volume, turnover] as
// strings, NEWEST FIRST. t=8h is still forming when now = 10h.
const H = 3600_000;
const rows = [
  ['28800000', '3', '9', '1', '5', '10', '0'], // t = 8h  (in progress)
  ['14400000', '2', '8', '2', '4', '10', '0'], // t = 4h  (closed)
  ['0',        '1', '7', '3', '3', '10', '0'], // t = 0h  (closed)
];

test('reverses newest-first rows into oldest-first bars', () => {
  const bars = normalizeKlines(rows, INTERVAL_4H, 10 * H);
  assert.deepEqual(bars.map((b) => b.t), [0, 14400000]);
});

test('drops the in-progress candle by default', () => {
  const bars = normalizeKlines(rows, INTERVAL_4H, 10 * H);
  assert.equal(bars.length, 2);
  assert.equal(bars.at(-1).c, 4);
});

test('keeps the in-progress candle when dropUnclosed is false', () => {
  const bars = normalizeKlines(rows, INTERVAL_4H, 10 * H, false);
  assert.equal(bars.length, 3);
  assert.equal(bars.at(-1).c, 5);
});

test('coerces strings to finite numbers', () => {
  const [b] = normalizeKlines(rows, INTERVAL_4H, 10 * H);
  assert.equal(typeof b.h, 'number');
  assert.deepEqual([b.o, b.h, b.l, b.c], [1, 7, 3, 3]);
});

test('returns an empty array for junk input', () => {
  assert.deepEqual(normalizeKlines(null, INTERVAL_4H, 0), []);
  assert.deepEqual(normalizeKlines([], INTERVAL_4H, 0), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/compute/klines.js'`

- [ ] **Step 4: Write the implementation**

`worker/src/compute/klines.js`:

```js
/**
 * Kline normalization — the single place venue quirks are absorbed.
 *
 * Bybit returns rows NEWEST-FIRST as string tuples:
 *   [startTime, open, high, low, close, volume, turnover]
 * Every compute module downstream assumes OLDEST-FIRST numeric bars, so if this
 * is wrong every derived signal is silently wrong with it.
 */

export const INTERVAL_4H = 4 * 60 * 60 * 1000;
export const INTERVAL_1D = 24 * 60 * 60 * 1000;

/**
 * @param {any[]} list      raw venue rows
 * @param {number} intervalMs  bar width, used to detect the forming candle
 * @param {number} now         caller-supplied clock (keeps this pure)
 * @param {boolean} dropUnclosed  false only for the daily pair, where PDH/PDL
 *                                needs TODAY's still-forming candle
 */
export function normalizeKlines(list, intervalMs, now, dropUnclosed = true) {
  if (!Array.isArray(list)) return [];
  const bars = list
    .map((r) => ({
      t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t);

  // The forming candle's close/high/low keep changing; including it makes every
  // signal flicker between refreshes.
  if (dropUnclosed) {
    while (bars.length && bars[bars.length - 1].t + intervalMs > now) bars.pop();
  }
  return bars;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/src/compute/klines.js worker/test/klines.test.js
git commit -m "Add kline normalization with test harness"
```

---

## Task 2: EMA34 alignment (score layer 4)

**Files:**
- Create: `worker/src/compute/ema.js`
- Test: `worker/test/ema.test.js`

**Interfaces:**
- Consumes: `Bar` from Task 1
- Produces:
  - `ema(values: number[], period: number) -> (number|null)[]` — aligned to input, `null` before the seed completes
  - `emaAlignment(bars: Bar[], period = 34, lookback = 3) -> { ema: number|null, close: number|null, side: -1|0|1 }`

- [ ] **Step 1: Write the failing test**

`worker/test/ema.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, emaAlignment } from '../src/compute/ema.js';

const bar = (c) => ({ t: 0, o: c, h: c + 1, l: c - 1, c, v: 1 });

test('returns nulls until the SMA seed completes', () => {
  const out = ema([1, 2, 3], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2); // SMA seed of [1,2,3]
});

test('is flat on a constant series', () => {
  const out = ema(new Array(40).fill(5), 34);
  assert.equal(out.at(-1), 5);
});

test('returns all nulls when there are fewer bars than the period', () => {
  assert.deepEqual(ema([1, 2], 34), [null, null]);
});

test('scores +1 when every recent close is above the EMA', () => {
  // Monotonic ramp: price is above its own trailing EMA throughout.
  const bars = Array.from({ length: 60 }, (_, i) => bar(100 + i));
  assert.equal(emaAlignment(bars).side, 1);
});

test('scores -1 when every recent close is below the EMA', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(200 - i));
  assert.equal(emaAlignment(bars).side, -1);
});

test('scores 0 when the last closes straddle the EMA', () => {
  const bars = Array.from({ length: 60 }, () => bar(100));
  // Nudge the final three closes to alternate around a flat EMA of 100.
  bars[57] = bar(101); bars[58] = bar(99); bars[59] = bar(101);
  assert.equal(emaAlignment(bars).side, 0);
});

test('degrades to side 0 when the series is too short to seed', () => {
  assert.deepEqual(emaAlignment([bar(1), bar(2)]), { ema: null, close: null, side: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test -- --test-name-pattern=EMA`
Expected: FAIL — `Cannot find module '../src/compute/ema.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/compute/ema.js`:

```js
/**
 * EMA + playbook §VII layer 4 ("EMA 34 alignment").
 *
 * The PRD specified limit=50 bars. EMA34 seeded from SMA(34) then has only 16
 * bars to converge, so the value still carries heavy seed bias and the layer
 * flips on noise. Callers must supply ~200 bars (≈5x period).
 */

/** Standard EMA seeded with an SMA of the first `period` values. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * §VII layer 4. "Body close" = the close of the most recent CLOSED candle,
 * which is already guaranteed by normalizeKlines dropping the forming bar.
 * "Oscillating inside EMA" = the last `lookback` closes sit on both sides.
 */
export function emaAlignment(bars, period = 34, lookback = 3) {
  const closes = bars.map((b) => b.c);
  const series = ema(closes, period);
  const last = series.length - 1;
  if (last < 0 || series[last] == null) return { ema: null, close: null, side: 0 };

  let above = false, below = false;
  for (let i = Math.max(0, last - lookback + 1); i <= last; i++) {
    if (series[i] == null) continue;
    if (closes[i] > series[i]) above = true;
    if (closes[i] < series[i]) below = true;
  }

  const side = above && below ? 0 : Math.sign(closes[last] - series[last]);
  return { ema: series[last], close: closes[last], side };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 12 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/compute/ema.js worker/test/ema.test.js
git commit -m "Add EMA34 alignment for score layer 4"
```

---

## Task 3: 50% equilibrium

**Files:**
- Create: `worker/src/compute/equilibrium.js`
- Test: `worker/test/equilibrium.test.js`

**Interfaces:**
- Consumes: `Bar` from Task 1
- Produces: `equilibrium(bars: Bar[], price: number, lookback = 30) -> { hh, ll, eq, zone: 'DISCOUNT'|'PREMIUM'|'EQ', pctToLow, pctToHigh, pctOfRange } | null`

- [ ] **Step 1: Write the failing test**

`worker/test/equilibrium.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { equilibrium } from '../src/compute/equilibrium.js';

// Range 100..200 over 4 bars -> EQ = 150.
const bars = [
  { t: 0, o: 0, h: 200, l: 150, c: 0, v: 0 },
  { t: 1, o: 0, h: 180, l: 100, c: 0, v: 0 },
  { t: 2, o: 0, h: 170, l: 120, c: 0, v: 0 },
  { t: 3, o: 0, h: 160, l: 130, c: 0, v: 0 },
];

test('computes the midpoint of the swing range', () => {
  const e = equilibrium(bars, 140);
  assert.equal(e.hh, 200);
  assert.equal(e.ll, 100);
  assert.equal(e.eq, 150);
});

test('labels price below the midpoint as DISCOUNT', () => {
  assert.equal(equilibrium(bars, 140).zone, 'DISCOUNT');
});

test('labels price above the midpoint as PREMIUM', () => {
  assert.equal(equilibrium(bars, 160).zone, 'PREMIUM');
});

test('reports distance to the swing extremes', () => {
  const e = equilibrium(bars, 110);
  assert.equal(Math.round(e.pctToLow * 100) / 100, 10);   // 10% above the low
  assert.equal(Math.round(e.pctToHigh * 100) / 100, 81.82); // 81.82% below the high
});

test('honours the lookback window', () => {
  const e = equilibrium(bars, 140, 2); // last 2 bars only: 120..170
  assert.equal(e.hh, 170);
  assert.equal(e.ll, 120);
});

test('returns null with no bars', () => {
  assert.equal(equilibrium([], 100), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/compute/equilibrium.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/compute/equilibrium.js`:

```js
/**
 * Playbook §VIII / PRD §4A — the valuation engine.
 * Longs are only valid in Discount (<50%), shorts only in Premium (>50%),
 * so this also feeds §III pillar 2 when that milestone lands.
 */
export function equilibrium(bars, price, lookback = 30) {
  const win = bars.slice(-lookback);
  if (!win.length) return null;

  let hh = -Infinity, ll = Infinity;
  for (const b of win) {
    if (b.h > hh) hh = b.h;
    if (b.l < ll) ll = b.l;
  }
  const eq = (hh + ll) / 2;
  const range = hh - ll;

  return {
    hh, ll, eq,
    zone: price < eq ? 'DISCOUNT' : price > eq ? 'PREMIUM' : 'EQ',
    pctToLow: (price / ll - 1) * 100,
    pctToHigh: (hh / price - 1) * 100,
    pctOfRange: range > 0 ? ((price - ll) / range) * 100 : 50,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 18 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/compute/equilibrium.js worker/test/equilibrium.test.js
git commit -m "Add 50% equilibrium valuation engine"
```

---

## Task 4: FVG detection (corrects the inverted PRD definitions)

**Files:**
- Create: `worker/src/compute/fvg.js`
- Test: `worker/test/fvg.test.js`

**Interfaces:**
- Consumes: `Bar` from Task 1
- Produces:
  - `findFvgs(bars: Bar[]) -> Gap[]` where `Gap = { type:'bull'|'bear', bottom:number, top:number, index:number, mitigated:boolean }`
  - `nearestUnmitigatedFvg(bars: Bar[], price: number) -> (Gap & { distPct:number }) | null`

**Why this task matters:** PRD §4B defines `Bullish FVG ⟵ Low[i-2] > High[i]`. With oldest-first bars `i-2` is the *older* candle, so that condition describes a gap **down** — bearish. Both PRD rows are swapped. The first test below is the permanent regression guard.

- [ ] **Step 1: Write the failing test**

`worker/test/fvg.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { findFvgs, nearestUnmitigatedFvg } from '../src/compute/fvg.js';

const b = (l, h) => ({ t: 0, o: l, h, l, c: h, v: 1 });

test('REGRESSION: a gap UP is labelled bullish, not bearish', () => {
  // bar0 high 10  <  bar2 low 20  -> price gapped up -> BULLISH
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].type, 'bull');
  assert.deepEqual([gaps[0].bottom, gaps[0].top], [10, 20]);
});

test('REGRESSION: a gap DOWN is labelled bearish, not bullish', () => {
  // bar0 low 20  >  bar2 high 10 -> price gapped down -> BEARISH
  const gaps = findFvgs([b(20, 25), b(12, 18), b(5, 10)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].type, 'bear');
  assert.deepEqual([gaps[0].bottom, gaps[0].top], [10, 20]);
});

test('finds no gap when candle 1 and candle 3 overlap', () => {
  assert.deepEqual(findFvgs([b(5, 15), b(8, 18), b(10, 20)]), []);
});

test('marks a gap mitigated once price trades back through its midpoint', () => {
  //  bull gap 10..20 (mid 15); a later bar wicks to 14 -> mitigated
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25), b(14, 30)]);
  assert.equal(gaps[0].mitigated, true);
});

test('leaves a gap unmitigated when price stays clear of the midpoint', () => {
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25), b(16, 30)]);
  assert.equal(gaps[0].mitigated, false);
});

test('returns the nearest unmitigated gap with a distance', () => {
  const bars = [b(5, 10), b(12, 18), b(20, 25), b(22, 30)];
  const near = nearestUnmitigatedFvg(bars, 25);
  assert.equal(near.type, 'bull');
  assert.equal(Math.round(near.distPct * 100) / 100, 20); // 25 -> 20 is 20% away
});

test('returns null when nothing is unmitigated', () => {
  assert.equal(nearestUnmitigatedFvg([b(5, 15), b(8, 18), b(10, 20)], 12), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/compute/fvg.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/compute/fvg.js`:

```js
/**
 * Fair Value Gaps over a 3-candle window. Bars are OLDEST-FIRST.
 *
 * !! The PRD had these inverted. With oldest-first bars index i-2 is the OLDER
 * candle, so:
 *     bullish (gap up):   high[i-2] < low[i]     gap = [high[i-2], low[i]]
 *     bearish (gap down): low[i-2]  > high[i]    gap = [high[i],   low[i-2]]
 * Swapping them points every FVG on the dashboard the wrong way, which is why
 * fvg.test.js opens with two explicit regression tests.
 */

/** A gap is mitigated once a later candle trades through >= 50% of its height. */
function isMitigated(gap, bars) {
  const mid = (gap.top + gap.bottom) / 2;
  for (let i = gap.index + 1; i < bars.length; i++) {
    if (gap.type === 'bull' && bars[i].l <= mid) return true;
    if (gap.type === 'bear' && bars[i].h >= mid) return true;
  }
  return false;
}

export function findFvgs(bars) {
  const gaps = [];
  for (let i = 2; i < bars.length; i++) {
    const older = bars[i - 2], newer = bars[i];
    if (older.h < newer.l) {
      gaps.push({ type: 'bull', bottom: older.h, top: newer.l, index: i });
    } else if (older.l > newer.h) {
      gaps.push({ type: 'bear', bottom: newer.h, top: older.l, index: i });
    }
  }
  for (const g of gaps) g.mitigated = isMitigated(g, bars);
  return gaps;
}

/** Nearest unmitigated gap by distance from `price` to its closest edge. */
export function nearestUnmitigatedFvg(bars, price) {
  let best = null, bestDist = Infinity;
  for (const g of findFvgs(bars)) {
    if (g.mitigated) continue;
    const edge = price > g.top ? g.top : price < g.bottom ? g.bottom : price;
    const dist = Math.abs((edge / price - 1) * 100);
    if (dist < bestDist) { bestDist = dist; best = g; }
  }
  return best ? { ...best, distPct: bestDist } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 25 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/compute/fvg.js worker/test/fvg.test.js
git commit -m "Add FVG detection, correcting the inverted PRD definitions"
```

---

## Task 5: PDH/PDL liquidity sweep (score layer 5)

**Files:**
- Create: `worker/src/compute/sweep.js`
- Test: `worker/test/sweep.test.js`

**Interfaces:**
- Consumes: `Bar` from Task 1
- Produces: `sweepState(prevDay: Bar|null, today: Bar|null, price: number) -> { layer: -1|0|1, label: string, pdh: number|null, pdl: number|null }`

**Note:** `today` is the **still-forming** daily candle, so the caller must build the daily pair with `normalizeKlines(rows, INTERVAL_1D, now, false)` — `dropUnclosed: false`. Day boundary is UTC (exchange convention), not WIB.

- [ ] **Step 1: Write the failing test**

`worker/test/sweep.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepState } from '../src/compute/sweep.js';

const day = (l, h) => ({ t: 0, o: l, h, l, c: h, v: 1 });
const prev = day(100, 200); // PDL 100, PDH 200

test('scores +1 when PDL is swept and reclaimed', () => {
  const s = sweepState(prev, day(95, 150), 120);
  assert.equal(s.layer, 1);
  assert.match(s.label, /PDL/);
});

test('scores -1 when PDH is swept and rejected', () => {
  const s = sweepState(prev, day(150, 210), 180);
  assert.equal(s.layer, -1);
  assert.match(s.label, /PDH/);
});

test('scores 0 when PDL is swept but price has not reclaimed', () => {
  assert.equal(sweepState(prev, day(95, 150), 98).layer, 0);
});

test('scores 0 when PDH is swept and price is still above it', () => {
  assert.equal(sweepState(prev, day(150, 210), 205).layer, 0);
});

test('scores 0 and flags when both sides are swept', () => {
  const s = sweepState(prev, day(95, 210), 150);
  assert.equal(s.layer, 0);
  assert.equal(s.label, 'both swept');
});

test('scores 0 inside the previous range', () => {
  const s = sweepState(prev, day(120, 180), 150);
  assert.equal(s.layer, 0);
  assert.match(s.label, /inside/);
});

test('degrades safely with missing data', () => {
  assert.equal(sweepState(null, day(1, 2), 1).layer, 0);
  assert.equal(sweepState(prev, null, 1).pdh, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/compute/sweep.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/compute/sweep.js`:

```js
/**
 * Playbook §VII layer 5 — liquidity sweep on the previous day's extremes.
 *
 * `today` must be the STILL-FORMING daily candle (build it with
 * normalizeKlines(..., dropUnclosed = false)), because the sweep we care about
 * is happening right now. Day boundary is UTC, matching exchange convention —
 * note this is 7h off from WIB.
 */
export function sweepState(prevDay, today, price) {
  if (!prevDay || !today) {
    return { layer: 0, label: 'no data', pdh: prevDay?.h ?? null, pdl: prevDay?.l ?? null };
  }
  const pdh = prevDay.h, pdl = prevDay.l;

  const reclaimedLow = today.l < pdl && price > pdl;
  const rejectedHigh = today.h > pdh && price < pdh;

  if (reclaimedLow && rejectedHigh) return { layer: 0, label: 'both swept', pdh, pdl };
  if (reclaimedLow) return { layer: 1, label: 'PDL swept + reclaimed', pdh, pdl };
  if (rejectedHigh) return { layer: -1, label: 'PDH swept + rejected', pdh, pdl };
  return { layer: 0, label: 'inside PDH/PDL range', pdh, pdl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 32 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/compute/sweep.js worker/test/sweep.test.js
git commit -m "Add PDH/PDL liquidity sweep detection"
```

---

## Task 6: Market mode detector

**Files:**
- Create: `worker/src/compute/mode.js`
- Test: `worker/test/mode.test.js`

**Interfaces:**
- Consumes: `Bar` from Task 1
- Produces: `marketMode(bars: Bar[], opts?: { lookback?: number, bosWithin?: number }) -> { mode: 'TREND'|'RANGE', direction: -1|0|1 }`

**Why it matters:** playbook §VI changes trade management in Range mode — fade only, 100% exit at the midpoint, **no runners**. This is not a cosmetic label.

- [ ] **Step 1: Write the failing test**

`worker/test/mode.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketMode } from '../src/compute/mode.js';

const bar = (l, h, c) => ({ t: 0, o: l, h, l, c, v: 1 });

test('flags TREND up when a recent body close breaks the prior swing high', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(90, 100, 95));   // base
  bars.push(bar(95, 120, 118));                                // swing high 120
  for (let i = 0; i < 5; i++) bars.push(bar(90, 100, 95));     // pull back
  bars.push(bar(115, 130, 128));                               // body close > 120
  const m = marketMode(bars);
  assert.equal(m.mode, 'TREND');
  assert.equal(m.direction, 1);
});

test('flags TREND down when a recent body close breaks the prior swing low', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(100, 110, 105));
  bars.push(bar(80, 105, 82));                                 // swing low 80
  for (let i = 0; i < 5; i++) bars.push(bar(100, 110, 105));
  bars.push(bar(60, 90, 65));                                  // body close < 80
  const m = marketMode(bars);
  assert.equal(m.mode, 'TREND');
  assert.equal(m.direction, -1);
});

test('flags RANGE when nothing breaks structure', () => {
  const bars = Array.from({ length: 20 }, (_, i) =>
    bar(95 + (i % 2), 105 - (i % 2), 100));
  assert.equal(marketMode(bars).mode, 'RANGE');
});

test('flags RANGE when the last BOS is older than bosWithin', () => {
  const bars = [];
  for (let i = 0; i < 5; i++) bars.push(bar(90, 100, 95));
  bars.push(bar(95, 120, 118));
  for (let i = 0; i < 5; i++) bars.push(bar(90, 100, 95));
  bars.push(bar(115, 130, 128));            // BOS happens here...
  for (let i = 0; i < 12; i++) bars.push(bar(120, 128, 124)); // ...long ago
  assert.equal(marketMode(bars).mode, 'RANGE');
});

test('degrades to RANGE with too few bars', () => {
  assert.deepEqual(marketMode([bar(1, 2, 1)]), { mode: 'RANGE', direction: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/compute/mode.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/compute/mode.js`:

```js
/**
 * PRD §4C / playbook §VI — TREND vs RANGE.
 *
 * Swing points via a 2-bar fractal; a BOS is a BODY CLOSE beyond the most recent
 * prior swing. If the last BOS is recent we are expanding (TREND); otherwise we
 * are oscillating (RANGE), which per §VI forbids runners entirely.
 */
export function marketMode(bars, { lookback = 30, bosWithin = 6 } = {}) {
  const win = bars.slice(-lookback);
  if (win.length < 9) return { mode: 'RANGE', direction: 0 };

  const highs = [], lows = [];
  for (let i = 2; i < win.length - 2; i++) {
    const { h, l } = win[i];
    if (h > win[i-1].h && h > win[i-2].h && h > win[i+1].h && h > win[i+2].h) highs.push({ i, p: h });
    if (l < win[i-1].l && l < win[i-2].l && l < win[i+1].l && l < win[i+2].l) lows.push({ i, p: l });
  }

  let lastBos = null;
  for (let i = 0; i < win.length; i++) {
    let priorHigh = null, priorLow = null;
    for (const s of highs) if (s.i < i) priorHigh = s;
    for (const s of lows)  if (s.i < i) priorLow = s;
    if (priorHigh && win[i].c > priorHigh.p) lastBos = { i, direction: 1 };
    if (priorLow  && win[i].c < priorLow.p)  lastBos = { i, direction: -1 };
  }

  if (lastBos && (win.length - 1 - lastBos.i) <= bosWithin) {
    return { mode: 'TREND', direction: lastBos.direction };
  }
  return { mode: 'RANGE', direction: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 37 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/compute/mode.js worker/test/mode.test.js
git commit -m "Add TREND/RANGE market mode detector"
```

---

## Task 7: §VII bias scoring engine

**Files:**
- Create: `worker/src/score.js`
- Test: `worker/test/score.test.js`

**Interfaces:**
- Consumes: `sweepState()` result (Task 5), `emaAlignment().side` (Task 2)
- Produces:
  - `THRESHOLDS: { priceMovePct, oiMovePct, fundingBullPct, fundingBearPct, etfFlowUsd }`
  - `scoreAsset(input) -> { total:number, verdict:string, cls:'long'|'short'|'chop', layers: Layer[] }`
    where `input = { etfFlow:number|null, etfProxy:boolean, funding:number, chg1h:number, oiD1h:number, emaSide:-1|0|1, sweep:{layer,label} }`
    and `Layer = { key:string, label:string, value:-1|0|1, detail:string, proxy?:boolean }`

- [ ] **Step 1: Write the failing test**

`worker/test/score.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAsset, THRESHOLDS } from '../src/score.js';

const base = {
  etfFlow: 0, etfProxy: false, funding: 0.005,
  chg1h: 0, oiD1h: 0, emaSide: 0,
  sweep: { layer: 0, label: 'inside PDH/PDL range' },
};
const layer = (r, key) => r.layers.find((l) => l.key === key).value;

test('all-neutral input scores 0 and reads CHOPPY', () => {
  const r = scoreAsset(base);
  assert.equal(r.total, 0);
  assert.equal(r.cls, 'chop');
  assert.match(r.verdict, /CHOPPY/);
});

test('a maximal bullish stack scores +5 and reads CLEAR TO LONG', () => {
  const r = scoreAsset({
    ...base, etfFlow: 100e6, funding: -0.01, chg1h: 1, oiD1h: 1,
    emaSide: 1, sweep: { layer: 1, label: 'PDL swept + reclaimed' },
  });
  assert.equal(r.total, 5);
  assert.equal(r.cls, 'long');
  assert.match(r.verdict, /CLEAR TO LONG/);
});

test('a maximal bearish stack scores -5 and reads CLEAR TO SHORT', () => {
  const r = scoreAsset({
    ...base, etfFlow: -100e6, funding: 0.05, chg1h: -1, oiD1h: -1,
    emaSide: -1, sweep: { layer: -1, label: 'PDH swept + rejected' },
  });
  assert.equal(r.total, -5);
  assert.equal(r.cls, 'short');
});

test('funding boundaries are exclusive and resolve to neutral', () => {
  assert.equal(layer(scoreAsset({ ...base, funding: 0 }), 'funding'), 0);
  assert.equal(layer(scoreAsset({ ...base, funding: THRESHOLDS.fundingBearPct }), 'funding'), 0);
  assert.equal(layer(scoreAsset({ ...base, funding: 0.012 }), 'funding'), 0); // the undefined band
  assert.equal(layer(scoreAsset({ ...base, funding: -0.0001 }), 'funding'), 1);
  assert.equal(layer(scoreAsset({ ...base, funding: 0.0151 }), 'funding'), -1);
});

test('OI layer stays literal to §VII: only two quadrants score', () => {
  const q = (chg1h, oiD1h) => scoreAsset({ ...base, chg1h, oiD1h });
  assert.equal(layer(q(1, 1), 'oi'), 1);    // long buildup
  assert.equal(layer(q(-1, -1), 'oi'), -1); // long flush
  assert.equal(layer(q(-1, 1), 'oi'), 0);   // fresh shorts -> unscored
  assert.equal(layer(q(1, -1), 'oi'), 0);   // short covering -> unscored
});

test('unscored OI quadrants are still labelled for the UI badge', () => {
  const detail = (chg1h, oiD1h) =>
    scoreAsset({ ...base, chg1h, oiD1h }).layers.find((l) => l.key === 'oi').detail;
  assert.equal(detail(-1, 1), 'fresh shorts');
  assert.equal(detail(1, -1), 'short covering');
});

test('a missing ETF flow scores 0 rather than throwing', () => {
  const r = scoreAsset({ ...base, etfFlow: null });
  assert.equal(layer(r, 'etf'), 0);
  assert.equal(r.layers.find((l) => l.key === 'etf').detail, 'no data');
});

test('the ETF layer carries the proxy flag through to the UI', () => {
  const r = scoreAsset({ ...base, etfFlow: 100e6, etfProxy: true });
  assert.equal(r.layers.find((l) => l.key === 'etf').proxy, true);
});

test('always returns exactly five layers', () => {
  assert.equal(scoreAsset(base).layers.length, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/score.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/score.js`:

```js
/**
 * Playbook §VII — the -5..+5 pre-market bias score.
 *
 * This is Phase 1 ("what is the bias?"). It is NOT verdict.js, which answers
 * Phase 2 ("is this pullback safe to enter?"). The two give opposite signs on
 * price-down + OI-down and must never be summed or averaged.
 */

export const THRESHOLDS = {
  // Measurement window for layer 3 is 1 hour. Neither §VII nor the PRD states
  // one; these are the values already tuned in the original Worker.
  priceMovePct: 0.15,
  oiMovePct: 0.25,
  fundingBullPct: 0,
  fundingBearPct: 0.015,
  etfFlowUsd: 50e6,
};

const fmtM = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v / 1e6).toFixed(0)}M`;

export function scoreAsset(input) {
  const T = THRESHOLDS;
  const layers = [];

  // Layer 1 — Spot ETF net flows (macro; proxied onto alts)
  let etf = 0;
  if (input.etfFlow != null) {
    if (input.etfFlow > T.etfFlowUsd) etf = 1;
    else if (input.etfFlow < -T.etfFlowUsd) etf = -1;
  }
  layers.push({
    key: 'etf', label: 'ETF', value: etf,
    detail: input.etfFlow == null ? 'no data' : fmtM(input.etfFlow),
    proxy: !!input.etfProxy,
  });

  // Layer 2 — Funding. §VII leaves 0–0.005% and 0.01–0.015% undefined; both
  // fall to neutral here, which is the conservative read. Bounds are exclusive.
  let funding = 0;
  if (input.funding < T.fundingBullPct) funding = 1;
  else if (input.funding > T.fundingBearPct) funding = -1;
  layers.push({
    key: 'funding', label: 'Fund', value: funding,
    detail: `${input.funding.toFixed(4)}%`,
  });

  // Layer 3 — OI + price delta. Kept LITERAL to §VII: only the two named
  // quadrants score. The other two are labelled for a UI badge but stay 0,
  // rather than inventing signs the playbook never assigned.
  const pUp = input.chg1h > T.priceMovePct;
  const pDown = input.chg1h < -T.priceMovePct;
  const oUp = input.oiD1h > T.oiMovePct;
  const oDown = input.oiD1h < -T.oiMovePct;

  let oi = 0, oiDetail = 'flat / stagnant OI';
  if (pUp && oUp) { oi = 1; oiDetail = 'long buildup'; }
  else if (pDown && oDown) { oi = -1; oiDetail = 'long flush'; }
  else if (pDown && oUp) { oiDetail = 'fresh shorts'; }
  else if (pUp && oDown) { oiDetail = 'short covering'; }
  layers.push({ key: 'oi', label: 'OI', value: oi, detail: oiDetail });

  // Layer 4 — EMA34 alignment
  layers.push({
    key: 'ema', label: 'EMA', value: input.emaSide,
    detail: input.emaSide === 0 ? 'oscillating inside EMA'
      : input.emaSide > 0 ? 'body close above EMA34' : 'body close below EMA34',
  });

  // Layer 5 — Liquidity sweep
  layers.push({
    key: 'sweep', label: 'Sweep', value: input.sweep.layer, detail: input.sweep.label,
  });

  const total = layers.reduce((s, l) => s + l.value, 0);
  const cls = total >= 3 ? 'long' : total <= -3 ? 'short' : 'chop';
  const verdict = cls === 'long' ? 'CLEAR TO LONG'
    : cls === 'short' ? 'CLEAR TO SHORT' : 'CHOPPY / RANGE';

  return { total, verdict, cls, layers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 46 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/score.js worker/test/score.test.js
git commit -m "Add section VII bias scoring engine"
```

---

## Task 8: Extract `walls.js` and `verdict.js` from the monolith

**Files:**
- Create: `worker/src/compute/walls.js`
- Create: `worker/src/verdict.js`
- Modify: `worker/src/index.js` — delete the moved blocks, import instead
- Test: `worker/test/walls.test.js`, `worker/test/verdict.test.js`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `computeWalls(bids, asks) -> { mid, band, bid, ask, imbalancePct } | null` (unchanged behaviour)
  - `verdict(d) -> { cls: 'ok'|'risk'|'mixed', msg: string }` (unchanged behaviour)

**This is a pure move, no behaviour change.** `computeWalls`, `sideWalls`, its `BAND`/`BIN_PCT`/`WALL_MULT`/`WALL_SHARE`/`MIN_BINS` constants, and `verdict` are lifted verbatim out of `worker/src/index.js`. The tests pin current behaviour so the later rewrite of `index.js` cannot silently change it.

- [ ] **Step 1: Move the wall code**

Cut `BAND`, `BIN_PCT`, `WALL_MULT`, `WALL_SHARE`, `MIN_BINS`, `sideWalls` and `computeWalls` out of `worker/src/index.js` into `worker/src/compute/walls.js` **unchanged**, adding `export` to `computeWalls` and keeping the existing doc comment at the top of the new file.

- [ ] **Step 2: Move the verdict code**

Cut the `verdict(d)` function out of `worker/src/index.js` into `worker/src/verdict.js` **unchanged**, adding `export`. Add this comment above it:

```js
/**
 * Phase 2 — pullback health. Answers "is this pullback absorption or a knife?"
 *
 * NOT the same question as score.js (§VII bias). On price-down + OI-down this
 * says "ok / deleveraging" while §VII scores -1 bearish. Both are correct for
 * their own question; never sum or average them.
 *
 * The planned TradingView -> Telegram worker must import THIS function rather
 * than reimplementing the read.
 */
```

- [ ] **Step 3: Wire the imports**

At the top of `worker/src/index.js`:

```js
import { computeWalls } from './compute/walls.js';
import { verdict } from './verdict.js';
```

- [ ] **Step 4: Write the pinning tests**

`worker/test/walls.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWalls } from '../src/compute/walls.js';

// Bids descending, asks ascending, [price, size].
function book(mid, spike) {
  const bids = [], asks = [];
  for (let i = 1; i <= 20; i++) {
    bids.push([String(mid * (1 - i * 0.0005)), '1']);
    asks.push([String(mid * (1 + i * 0.0005)), '1']);
  }
  if (spike) asks[8][1] = '50'; // a clear outlier bin
  return { bids, asks };
}

test('returns null without both sides', () => {
  assert.equal(computeWalls([], [['1', '1']]), null);
  assert.equal(computeWalls(null, null), null);
});

test('reports a smooth side when no bin is an outlier', () => {
  const { bids, asks } = book(100, false);
  assert.equal(computeWalls(bids, asks).ask.nearestWall, null);
});

test('finds an outlier ask wall and reports it outward of mid', () => {
  const { bids, asks } = book(100, true);
  const w = computeWalls(bids, asks);
  assert.ok(w.ask.nearestWall);
  assert.ok(w.ask.nearestWall.distPct > 0);
});

test('imbalance is 50% on a symmetric book', () => {
  const { bids, asks } = book(100, false);
  assert.equal(Math.round(computeWalls(bids, asks).imbalancePct), 50);
});
```

`worker/test/verdict.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../src/verdict.js';

const base = { chg1h: 0, oiD1h: 0, funding: 0.005, taker: null, book: null };

test('price down + OI down reads as healthy deleveraging', () => {
  const v = verdict({ ...base, chg1h: -0.5, oiD1h: -1 });
  assert.equal(v.cls, 'ok');
  assert.match(v.msg, /deleverag/i);
});

test('price down + OI up reads as fresh shorts and is flagged risk', () => {
  const v = verdict({ ...base, chg1h: -0.5, oiD1h: 1 });
  assert.equal(v.cls, 'risk');
});

test('DIVERGENCE IS INTENTIONAL: this contradicts score.js by design', () => {
  // §VII scores price-down + OI-down as -1 (long flush); verdict() calls the
  // same state 'ok'. They answer different questions. If this test ever fails
  // because someone "fixed" the inconsistency, read the spec first.
  assert.equal(verdict({ ...base, chg1h: -0.5, oiD1h: -1 }).cls, 'ok');
});

test('flat hour falls through to mixed', () => {
  assert.equal(verdict(base).cls, 'mixed');
});
```

- [ ] **Step 5: Run tests**

Run: `cd worker && npm test`
Expected: PASS — 54 tests total

- [ ] **Step 6: Commit**

```bash
git add worker/src/compute/walls.js worker/src/verdict.js worker/src/index.js \
        worker/test/walls.test.js worker/test/verdict.test.js
git commit -m "Extract order-book walls and verdict into their own modules"
```

---

## Task 9: Pair allowlist and the Bybit source

**Files:**
- Create: `worker/src/pairs.js`
- Create: `worker/src/sources/bybit.js`
- Test: `worker/test/pairs.test.js`

**Interfaces:**
- Consumes: `normalizeKlines`, `INTERVAL_4H`, `INTERVAL_1D` (Task 1)
- Produces:
  - `PAIRS: Record<string, { bybit, okxInst, okxCcy, binance }>`
  - `DEFAULT_WATCHLIST: string[]`
  - `resolvePair(raw: string) -> { base: string, bybit, okxInst, okxCcy, binance }`
  - `bybitCore(sym, now, fetchJson) -> CoreData`
  - `bybitDeep(sym, fetchJson) -> { book, accountLS }`

**Subrequest budget note:** the shallow path is **4 Bybit calls** — tickers, 4H klines, 1D klines, OI history — plus **2 macro calls** (CoinGecko + Farside) that score layer 1 needs, for **6 per invocation**. The macro pair is edge-cached for 900s and keyed by URL, so all eight assets share one upstream fetch; only the first invocation after expiry actually pays for it.

`chg1h` comes from the ticker's `prevPrice1h` field and `chg24h` from `price24hPcnt`, so no hourly-kline call is needed on the matrix path. `chg4h` is display-only and moves to the `deep=1` path. This is what keeps the shallow route cheap enough to fan out across a 20-pair allowlist without approaching the 50-subrequest ceiling.

- [ ] **Step 1: Write the failing test**

`worker/test/pairs.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAIRS, DEFAULT_WATCHLIST, resolvePair } from '../src/pairs.js';

test('defaults to the playbook section II watchlist', () => {
  assert.deepEqual(DEFAULT_WATCHLIST,
    ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB']);
});

test('every default watchlist entry exists in the allowlist', () => {
  for (const b of DEFAULT_WATCHLIST) assert.ok(PAIRS[b], `${b} missing from PAIRS`);
});

test('resolves a known base case-insensitively', () => {
  assert.equal(resolvePair('sol').base, 'SOL');
  assert.equal(resolvePair('SOL').bybit, 'SOLUSDT');
});

test('falls back to BTC for anything not on the allowlist', () => {
  // Guards against arbitrary ?symbol= strings reaching upstream URLs.
  assert.equal(resolvePair('../../etc/passwd').base, 'BTC');
  assert.equal(resolvePair('').base, 'BTC');
});

test('every pair carries all four venue identifiers', () => {
  for (const [base, p] of Object.entries(PAIRS)) {
    for (const k of ['bybit', 'okxInst', 'okxCcy', 'binance']) {
      assert.ok(p[k], `${base}.${k} missing`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/pairs.js'`

- [ ] **Step 3: Write the allowlist**

`worker/src/pairs.js`:

```js
/**
 * Symbol allowlist. IDs are derivable from the base coin, but keeping an
 * explicit map both documents the supported set and stops arbitrary ?symbol=
 * strings being interpolated into upstream URLs.
 *
 * DEFAULT_WATCHLIST is playbook §II's fixed eight. The wider allowlist exists
 * because the trade journal shows real rotation (HYPE, WLD, RENDER, ZEC, ONDO)
 * that would otherwise need a redeploy to follow.
 *
 * UNVERIFIED: venue coverage for HYPE, WLD, RENDER, ZEC, ONDO, ASTER and JTO
 * has not been confirmed against Bybit/OKX. Check before relying on them; a
 * missing OKX instrument degrades to Bybit-only rather than failing.
 */
const mk = (base) => ({
  bybit: `${base}USDT`,
  okxInst: `${base}-USDT-SWAP`,
  okxCcy: base,
  binance: `${base}USDT`,
});

export const PAIRS = Object.fromEntries([
  // Playbook §II — anchors + beta basket
  'BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB',
  // Traded in the journal but not in §II
  'HYPE', 'WLD', 'RENDER', 'ZEC', 'ONDO', 'ASTER', 'JTO',
  // Previously supported majors
  'XRP', 'BNB', 'DOGE', 'ADA',
].map((b) => [b, mk(b)]));

export const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB'];

export function resolvePair(raw) {
  const base = String(raw || '').toUpperCase();
  return PAIRS[base] ? { base, ...PAIRS[base] } : { base: 'BTC', ...PAIRS.BTC };
}
```

- [ ] **Step 4: Write the Bybit source**

`worker/src/sources/bybit.js`:

```js
import { normalizeKlines, INTERVAL_4H, INTERVAL_1D } from '../compute/klines.js';

const B = 'https://api.bybit.com';

/**
 * Core venue — reachable from the Cloudflare edge, unlike Binance.
 * Exactly FOUR calls, to keep a fan-out invocation cheap:
 *   tickers (price, chg1h via prevPrice1h, chg24h, funding, OI level)
 *   4H klines x200  (EMA34 / equilibrium / FVG / mode)
 *   1D klines x2    (PDH/PDL — keeps the forming candle)
 *   OI history      (oiD1h / oiD4h)
 */
export async function bybitCore(sym, now, j) {
  const S = sym.bybit;
  const [tick, k4, kd, oiH] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear&symbol=${S}`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=240&limit=200`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=D&limit=2`),
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`),
  ]);

  const t = tick.result.list[0];
  const mark = +t.lastPrice;

  const bars4h = normalizeKlines(k4.result.list, INTERVAL_4H, now);
  // Daily KEEPS the forming candle: today's running high/low is the sweep.
  const days = normalizeKlines(kd.result.list, INTERVAL_1D, now, false);
  const today = days.at(-1) ?? null;
  const prevDay = days.length > 1 ? days.at(-2) : null;

  const oiL = oiH.result.list; // newest first
  const oiNow = +oiL[0].openInterest;
  const oi1h = +oiL[1]?.openInterest;
  const oi4h = +oiL[4]?.openInterest;

  return {
    source: 'Bybit linear',
    mark,
    chg1h: t.prevPrice1h ? (mark / +t.prevPrice1h - 1) * 100 : 0,
    chg24h: +t.price24hPcnt * 100,
    funding: +t.fundingRate * 100,
    nextFundingTime: +t.nextFundingTime,
    oiCoin: oiNow,
    oiUsd: oiNow * mark,
    oiD1h: Number.isFinite(oi1h) && oi1h ? (oiNow / oi1h - 1) * 100 : 0,
    oiD4h: Number.isFinite(oi4h) && oi4h ? (oiNow / oi4h - 1) * 100 : 0,
    bars4h, prevDay, today,
  };
}

/** deep=1 only: book walls, account L/S, and the 4h change for display. */
export async function bybitDeep(sym, j) {
  const S = sym.bybit;
  const [ob, acct, k1h] = await Promise.all([
    j(`${B}/v5/market/orderbook?category=linear&symbol=${S}&limit=500`).catch(() => null),
    j(`${B}/v5/market/account-ratio?category=linear&symbol=${S}&period=1h&limit=1`).catch(() => null),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=5`).catch(() => null),
  ]);
  const r = acct?.result?.list?.[0];
  const closes = k1h?.result?.list?.map((k) => +k[4]); // newest first
  return {
    raw: ob?.result ?? null,
    accountLS: r ? +r.buyRatio / +r.sellRatio : null,
    close4hAgo: closes?.[4] ?? null,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `cd worker && npm test`
Expected: PASS — 59 tests total

- [ ] **Step 6: Commit**

```bash
git add worker/src/pairs.js worker/src/sources/bybit.js worker/test/pairs.test.js
git commit -m "Add pair allowlist and Bybit source module"
```

---

## Task 10: OKX and Binance sources

**Files:**
- Create: `worker/src/sources/okx.js`
- Create: `worker/src/sources/binance.js`

**Interfaces:**
- Consumes: `computeWalls` (Task 8)
- Produces:
  - `okxExtras(sym, j) -> { oiCoin, taker, ls, book } | null`
  - `binanceExtras(sym, j) -> { oiCoin, taker, topLS }`

These are lifted from the existing `okx()` and `binance()` functions in `worker/src/index.js`, moved into their own files and given the injected `j` fetcher. Both are `deep=1`-only — no §VII layer depends on them, so the matrix path never pays for them.

- [ ] **Step 1: Write the OKX source**

`worker/src/sources/okx.js`:

```js
import { computeWalls } from '../compute/walls.js';

const O = 'https://www.okx.com';

/**
 * OKX extras — taker flow, account L/S, OI, and the deepest free REST book.
 * Every call is individually optional: a missing instrument (HYPE and the
 * newer listings are the risk) degrades to Bybit rather than failing the row.
 */
export async function okxExtras(sym, j) {
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [oi, taker, ls, ob, instr] = await Promise.all([
    j(`${O}/api/v5/public/open-interest?instId=${inst}`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1H`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/market/books-full?instId=${inst}&sz=5000`).catch(() => null),
    j(`${O}/api/v5/public/instruments?instType=SWAP&instId=${inst}`).catch(() => null),
  ]);

  // taker-volume rows are [ts, sellVol, buyVol], newest first
  let takerRatio = null;
  const tr = taker?.data?.[0];
  if (tr) { const sell = +tr[1], buy = +tr[2]; takerRatio = sell ? buy / sell : null; }

  let book = null;
  if (ob?.data?.[0]) {
    // OKX book sizes are in CONTRACTS; ctVal converts to base coin.
    const ctVal = +instr?.data?.[0]?.ctVal;
    const scale = Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1;
    const conv = (lv) => lv.map((l) => [l[0], +l[1] * scale]);
    book = computeWalls(conv(ob.data[0].bids), conv(ob.data[0].asks));
    if (book) book.source = 'OKX books-full';
  }

  return {
    oiCoin: oi?.data?.[0] ? +oi.data[0].oiCcy : null,
    taker: takerRatio,
    ls: ls?.data?.[0] ? +ls.data[0][1] : null,
    book,
  };
}
```

- [ ] **Step 2: Write the Binance source**

`worker/src/sources/binance.js`:

```js
const B = 'https://fapi.binance.com';

/**
 * Opportunistic only. fapi is geo-blocked from Indonesia AND from the Jakarta
 * Cloudflare edge, so this usually throws — callers must treat failure as
 * normal. The page also retries these from the user's own device, where a
 * phone or VPN often can reach Binance (see src/binance-enrich.js).
 */
export async function binanceExtras(sym, j) {
  const S = sym.binance;
  const [oiHist, taker, topls] = await Promise.all([
    j(`${B}/futures/data/openInterestHist?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
  ]);
  return {
    oiCoin: +oiHist[0].sumOpenInterest,
    taker: +taker[0].buySellRatio,
    topLS: +topls[0].longShortRatio,
  };
}
```

- [ ] **Step 3: Run tests to confirm nothing regressed**

Run: `cd worker && npm test`
Expected: PASS — 59 tests, unchanged

- [ ] **Step 4: Commit**

```bash
git add worker/src/sources/okx.js worker/src/sources/binance.js
git commit -m "Move OKX and Binance fetching into source modules"
```

---

## Task 11: Macro source — dominance and ETF flows

**Files:**
- Create: `worker/src/sources/macro.js`
- Test: `worker/test/macro.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseDominance(payload) -> { btcD, usdtD, total3, totalMcap } | null`
  - `parseFarsideTotal(html) -> number | null` (USD, not millions)
  - `fetchMacro(j) -> { btcD, usdtD, total3, totalMcap, etfBtc, etfEth, etfAsOf }`

**Reality check:** ETF flow has no reliable free CORS-friendly source. Farside is HTML and scraper-hostile. The parse function is unit-tested against a fixture so a format change fails loudly in tests, but the fetch must return `null` on any failure and the score layer must fall to `0`.

- [ ] **Step 1: Write the failing test**

`worker/test/macro.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDominance, parseFarsideTotal } from '../src/sources/macro.js';

test('derives TOTAL3 by excluding BTC and ETH dominance', () => {
  const d = parseDominance({
    data: {
      total_market_cap: { usd: 1000 },
      market_cap_percentage: { btc: 50, eth: 10, usdt: 5 },
    },
  });
  assert.equal(d.btcD, 50);
  assert.equal(d.usdtD, 5);
  assert.equal(d.total3, 400); // 1000 * (100-50-10)/100
});

test('returns null for a malformed dominance payload', () => {
  assert.equal(parseDominance({}), null);
  assert.equal(parseDominance(null), null);
});

test('reads the last dated row total from a Farside table', () => {
  const html = `<table>
    <tr><td>01 Jan 2026</td><td>10.0</td><td>120.5</td></tr>
    <tr><td>02 Jan 2026</td><td>5.0</td><td>(87.3)</td></tr>
    <tr><td>Total</td><td>15.0</td><td>33.2</td></tr>
  </table>`;
  // Last DATED row is 02 Jan; (87.3) is an accounting negative, in $m.
  assert.equal(parseFarsideTotal(html), -87.3e6);
});

test('returns null when no dated row is present', () => {
  assert.equal(parseFarsideTotal('<table><tr><td>Total</td><td>5</td></tr></table>'), null);
  assert.equal(parseFarsideTotal(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `Cannot find module '../src/sources/macro.js'`

- [ ] **Step 3: Write the implementation**

`worker/src/sources/macro.js`:

```js
/**
 * Macro layer: CoinGecko dominance (display only) + spot ETF flows (score
 * layer 1).
 *
 * Dominance MUST NOT enter the score — the PRD is explicit about this and the
 * §VII table has no dominance row.
 *
 * ETF flow is the flakiest input in the whole system: Farside is HTML, has no
 * CORS headers and is scraper-hostile. Everything here returns null rather than
 * throwing, and score.js treats null as a neutral 0.
 */

const CG = 'https://api.coingecko.com/api/v3/global';
const FARSIDE = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';

export function parseDominance(payload) {
  const d = payload?.data;
  const total = d?.total_market_cap?.usd;
  const pct = d?.market_cap_percentage;
  if (!Number.isFinite(total) || !pct) return null;
  const btcD = +pct.btc, ethD = +pct.eth, usdtD = +pct.usdt;
  if (!Number.isFinite(btcD) || !Number.isFinite(ethD)) return null;
  return {
    btcD, usdtD, totalMcap: total,
    total3: total * (100 - btcD - ethD) / 100,
  };
}

/**
 * Farside renders one row per day with the net total in the last cell, in $m,
 * using accounting parentheses for negatives. We take the last DATED row.
 */
export function parseFarsideTotal(html) {
  if (typeof html !== 'string' || !html) return null;
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const cells = (rows[i].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (!cells.length) continue;
    if (!/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(cells[0])) continue; // dated rows only
    const raw = cells[cells.length - 1];
    const neg = /^\(.*\)$/.test(raw);
    const n = parseFloat(raw.replace(/[(),$]/g, ''));
    if (!Number.isFinite(n)) return null;
    return (neg ? -n : n) * 1e6; // $m -> $
  }
  return null;
}

export async function fetchMacro(j) {
  const [dom, etf] = await Promise.all([
    j(CG).then(parseDominance).catch(() => null),
    j(FARSIDE, { text: true }).then(parseFarsideTotal).catch(() => null),
  ]);
  return {
    btcD: dom?.btcD ?? null,
    usdtD: dom?.usdtD ?? null,
    total3: dom?.total3 ?? null,
    totalMcap: dom?.totalMcap ?? null,
    // ETH spot ETF has no equivalent free feed; left null so score.js neutralises
    // the layer for ETH rather than misreporting BTC flow as ETH flow.
    etfBtc: etf,
    etfEth: null,
    etfAsOf: etf == null ? null : Date.now(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npm test`
Expected: PASS — 63 tests total

- [ ] **Step 5: Commit**

```bash
git add worker/src/sources/macro.js worker/test/macro.test.js
git commit -m "Add macro source for dominance and ETF flows"
```

---

## Task 12: Rewrite the Worker entry point

**Files:**
- Modify: `worker/src/index.js` — full rewrite, routing only

**Interfaces:**
- Consumes: everything from Tasks 1–11
- Produces: HTTP surface
  - `GET /asset?symbol=X[&etf=in|out|flat][&deep=1][&debug=1][&bins=1]`
  - `GET /macro`

- [ ] **Step 1: Replace `worker/src/index.js` entirely**

```js
/**
 * Perp Pulse data Worker — routing only. All market logic lives in
 * compute/, sources/, score.js and verdict.js.
 *
 * Why this Worker exists (do not remove it): the browser cannot call the
 * exchanges directly. Binance futures/data/* sends no CORS headers, and
 * fapi is geo-blocked from Indonesia and from the Jakarta CF edge. The fetch
 * happens here instead, and this returns permissive CORS.
 */
import { resolvePair } from './pairs.js';
import { bybitCore, bybitDeep } from './sources/bybit.js';
import { okxExtras } from './sources/okx.js';
import { binanceExtras } from './sources/binance.js';
import { fetchMacro } from './sources/macro.js';
import { computeWalls } from './compute/walls.js';
import { emaAlignment } from './compute/ema.js';
import { equilibrium } from './compute/equilibrium.js';
import { nearestUnmitigatedFvg } from './compute/fvg.js';
import { sweepState } from './compute/sweep.js';
import { marketMode } from './compute/mode.js';
import { scoreAsset } from './score.js';
import { verdict } from './verdict.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});

/** Fetcher with an edge cache TTL, injected into every source module. */
const fetcher = (ttl) => async (url, { text = false } = {}) => {
  const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`${url.replace(/\?.*/, '')} -> ${r.status}`);
  return text ? r.text() : r.json();
};

async function attempt(fn) {
  try { return { ok: true, val: await fn() }; }
  catch (e) { return { ok: false, err: e.message }; }
}

/** Manual ETF override from the header toggle, when the feed is unreachable. */
function manualEtf(flag) {
  if (flag === 'in') return 60e6;
  if (flag === 'out') return -60e6;
  if (flag === 'flat') return 0;
  return undefined;
}

async function handleAsset(url) {
  const now = Date.now();
  const sym = resolvePair(url.searchParams.get('symbol') || 'BTC');
  const deep = url.searchParams.has('deep');
  const debug = url.searchParams.has('debug');
  const showBins = url.searchParams.has('bins');

  const [core, macro, okx, bn, deepRes] = await Promise.all([
    attempt(() => bybitCore(sym, now, fetcher(30))),
    attempt(() => fetchMacro(fetcher(900))),
    deep ? attempt(() => okxExtras(sym, fetcher(15))) : Promise.resolve({ ok: false, err: 'skipped' }),
    deep ? attempt(() => binanceExtras(sym, fetcher(15))) : Promise.resolve({ ok: false, err: 'skipped' }),
    deep ? attempt(() => bybitDeep(sym, fetcher(15))) : Promise.resolve({ ok: false, err: 'skipped' }),
  ]);

  if (!core.ok) {
    return json({ symbol: sym.base, error: 'Core source (Bybit) unreachable', detail: core.err }, 502);
  }

  const c = core.val;
  const m = macro.ok ? macro.val : {};

  // §VII layer 1: BTC uses BTC flow, ETH uses ETH flow, everything else is
  // proxied off BTC and tagged so the UI never presents it as asset-specific.
  const override = manualEtf(url.searchParams.get('etf'));
  const own = sym.base === 'BTC' ? m.etfBtc : sym.base === 'ETH' ? m.etfEth : null;
  const etfProxy = sym.base !== 'BTC' && sym.base !== 'ETH';
  const etfFlow = override !== undefined ? override : (etfProxy ? (m.etfBtc ?? null) : (own ?? null));

  const ema = emaAlignment(c.bars4h, 34);
  const eq = equilibrium(c.bars4h, c.mark, 30);
  const fvg = nearestUnmitigatedFvg(c.bars4h, c.mark);
  const sweep = sweepState(c.prevDay, c.today, c.mark);
  const mode = marketMode(c.bars4h);

  const score = scoreAsset({
    etfFlow, etfProxy, funding: c.funding,
    chg1h: c.chg1h, oiD1h: c.oiD1h, emaSide: ema.side, sweep,
  });

  const payload = {
    ts: now,
    symbol: sym.base,
    source: c.source,
    price: { mark: c.mark, chg1h: c.chg1h, chg24h: c.chg24h, chg4h: null },
    funding: { rate: c.funding, nextFundingTime: c.nextFundingTime },
    oi: { coin: c.oiCoin, usd: c.oiUsd, d1h: c.oiD1h, d4h: c.oiD4h },
    signals: {
      ema: { value: ema.ema, side: ema.side },
      equilibrium: eq,
      fvg,
      sweep,
      mode,
    },
    score,
  };

  if (deep) {
    const okv = okx.ok ? okx.val : null;
    const bnv = bn.ok ? bn.val : null;
    const dv = deepRes.ok ? deepRes.val : null;

    if (dv?.close4hAgo) payload.price.chg4h = (c.mark / dv.close4hAgo - 1) * 100;

    const venues = { bybit: c.oiCoin, okx: okv?.oiCoin ?? null, binance: bnv?.oiCoin ?? null };
    const agg = Object.values(venues).filter((v) => v != null).reduce((s, v) => s + v, 0);
    payload.oi.venues = venues;
    payload.oi.aggCoin = agg;
    payload.oi.aggUsd = agg * c.mark;

    const taker = bnv?.taker ?? okv?.taker ?? null;
    const topLS = bnv?.topLS ?? okv?.ls ?? dv?.accountLS ?? null;
    payload.positioning = {
      taker, topLS,
      source: bnv?.topLS != null ? 'Binance top-trader'
        : okv?.ls != null ? 'OKX accounts'
        : dv?.accountLS != null ? 'Bybit accounts' : 'n/a',
    };

    const book = okv?.book || (dv?.raw ? computeWalls(dv.raw.b, dv.raw.a) : null);
    if (book && !book.source) book.source = 'Bybit';
    if (book && !showBins) { delete book.bid.dbg; delete book.ask.dbg; }
    payload.book = book;

    // Phase 2 — a DIFFERENT question from score. Never merged with it.
    payload.health = verdict({
      chg1h: c.chg1h, oiD1h: c.oiD1h, funding: c.funding, taker, book,
    });
  }

  if (debug) {
    payload.diag = {
      bybit: 'ok',
      macro: macro.ok ? 'ok' : macro.err,
      okx: okx.ok ? 'ok' : okx.err,
      binance: bn.ok ? 'ok' : bn.err,
    };
  }
  return json(payload);
}

async function handleMacro() {
  const r = await attempt(() => fetchMacro(fetcher(900)));
  return json(r.ok ? { ts: Date.now(), ...r.val } : { ts: Date.now(), error: r.err });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/macro') return handleMacro();
    return handleAsset(url);
  },
};
```

- [ ] **Step 2: Run the full suite**

Run: `cd worker && npm test`
Expected: PASS — 63 tests total

- [ ] **Step 3: Smoke test against the live edge**

Run: `cd worker && npx wrangler dev --port 8787`

In another terminal:

```bash
curl -s 'http://127.0.0.1:8787/asset?symbol=BTC&debug=1' | head -c 800
```

Expected: JSON containing `"score"` with a `total` between −5 and +5 and a `layers` array of length 5. Confirm `signals.ema.value` is a number near the BTC price (not `null`) — `null` means the 200-bar kline fetch failed.

```bash
curl -s 'http://127.0.0.1:8787/macro' | head -c 400
```

Expected: JSON with `btcD`, `usdtD`, `total3`. `etfBtc` may legitimately be `null`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "Rewrite Worker entry point as routing over compute modules"
```

---

## Task 13: Page shell, stylesheet and formatters

**Files:**
- Modify: `index.html` — full rewrite, markup only
- Create: `styles.css`
- Create: `src/format.js`
- Test: manual (browser preview)

**Interfaces:**
- Consumes: nothing
- Produces: `fmtPct`, `fmtPrice`, `fmtCoin`, `fmtUsd`, `fmtScore`, `signClass`, `countdown` from `src/format.js`

- [ ] **Step 1: Write the formatters**

`src/format.js`:

```js
// Base-coin amounts vary hugely across pairs (thousands of BTC vs billions of
// DOGE), and prices span 60000 to 0.38, so every formatter scales by magnitude.
export const fmtPct = (v, dp = 2) => (v >= 0 ? '+' : '') + v.toFixed(dp) + '%';

export const fmtPrice = (v) =>
  v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  : v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : v.toLocaleString('en-US', { maximumFractionDigits: 5 });

export const fmtCoin = (v) =>
  v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
  : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
  : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k'
  : v.toFixed(1);

export const fmtUsd = (v) =>
  Math.abs(v) >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T'
  : Math.abs(v) >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
  : '$' + (v / 1e6).toFixed(0) + 'M';

export const fmtScore = (n) => (n > 0 ? '+' : '') + n;
export const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

export function countdown(ts) {
  const s = Math.max(0, ts - Date.now());
  const h = Math.floor(s / 3.6e6), m = Math.floor((s % 3.6e6) / 6e4);
  return h + 'h ' + String(m).padStart(2, '0') + 'm';
}
```

- [ ] **Step 2: Write the markup shell**

`index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0E14">
<title>Perp Pulse</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header>
  <h1>PERP<span>·</span>PULSE</h1>
  <div class="hdr-actions">
    <button id="etf-toggle" class="ghost" title="Spot ETF net flow (score layer 1)">ETF —</button>
    <button id="refresh" class="ghost">Refresh</button>
  </div>
</header>

<div class="weather" id="weather">
  <div class="w-item"><span class="w-label">BTC.D</span><span class="w-val" id="w-btcd">—</span></div>
  <div class="w-item"><span class="w-label">USDT.D</span><span class="w-val" id="w-usdtd">—</span></div>
  <div class="w-item"><span class="w-label">TOTAL3</span><span class="w-val" id="w-total3">—</span></div>
</div>

<div id="stale" class="stale" hidden></div>
<div id="err" hidden></div>

<main id="matrix" class="matrix"></main>

<section id="detail" class="detail" hidden></section>

<details class="legend">
  <summary>Sanity check legend</summary>
  <p><b>Normal pullback 🟢</b> — OI stable or rising (absorption) + funding neutral or negative.</p>
  <p><b>Aggressive dump 🔴</b> — heavy OI flush (cascade) + funding heavily positive + ETF outflows.</p>
</details>

<footer>
  <span id="src">—</span>
  <span id="ts"></span>
</footer>

<script type="module" src="src/main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write the stylesheet**

`styles.css`:

```css
:root{
  --bg:#0B0E14; --card:#11151F; --border:#1E2530;
  --text:#E6EAF2; --muted:#8A94A6;
  --up:#2FBF71; --down:#E5484D; --warn:#F5A623; --steel:#5B8DEF;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--bg);color:var(--text);
  font-family:'IBM Plex Mono',ui-monospace,monospace;
  min-height:100vh;padding:16px 14px calc(24px + env(safe-area-inset-bottom));
  max-width:560px;margin:0 auto;
}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-family:'Space Grotesk',sans-serif;font-size:19px;font-weight:700;letter-spacing:.02em}
h1 span{color:var(--steel)}
.hdr-actions{display:flex;gap:6px}
.ghost{
  background:var(--card);border:1px solid var(--border);color:var(--text);
  font:inherit;font-size:12px;padding:7px 12px;border-radius:8px;cursor:pointer;
}
.ghost:focus-visible{outline:2px solid var(--steel);outline-offset:2px}
.ghost[disabled]{opacity:.5}

/* Market weather — deliberately muted: context, never signal. */
.weather{display:flex;gap:14px;padding:8px 12px;margin-bottom:12px;
  border:1px dashed var(--border);border-radius:8px;color:var(--muted)}
.w-item{display:flex;gap:6px;font-size:11px}
.w-val{color:var(--text);font-variant-numeric:tabular-nums}

.stale{background:#3A2A0B;border:1px solid #6B4E12;color:#F5D08A;
  border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:10px}
#err{background:#2A1215;border:1px solid #5C2226;color:#F2B8B5;
  border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:10px}

.matrix{display:flex;flex-direction:column;gap:8px}
.row{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--muted);
  border-radius:10px;padding:11px 12px;cursor:pointer}
.row.long{border-left-color:var(--up)}
.row.short{border-left-color:var(--down)}
.row.chop{border-left-color:var(--warn)}
.row.err{opacity:.55}
.row-top{display:flex;align-items:baseline;gap:8px}
.tkr{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;width:56px}
.score{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.vd{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.px{margin-left:auto;font-size:13px;font-variant-numeric:tabular-nums}
.row-mid{display:flex;gap:10px;font-size:11px;color:var(--muted);margin-top:5px;flex-wrap:wrap}
.row-bot{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.badge{font-size:10px;padding:2px 7px;border-radius:999px;
  border:1px solid var(--border);color:var(--muted)}
.badge.hot{border-color:var(--warn);color:var(--warn)}
.pos{color:var(--up)} .neg{color:var(--down)} .flat{color:var(--muted)}

/* Score chips — a total is never shown without its five layers. */
.chips{display:flex;gap:5px;flex-wrap:wrap;margin:10px 0}
.chip{font-size:10px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);
  color:var(--muted);font-variant-numeric:tabular-nums}
.chip.pos{border-color:var(--up);color:var(--up)}
.chip.neg{border-color:var(--down);color:var(--down)}
.chip .pxy{opacity:.6;font-size:9px;margin-left:3px}

.detail{background:var(--card);border:1px solid var(--border);border-radius:10px;
  padding:14px;margin-top:12px}
.detail h2{font-family:'Space Grotesk',sans-serif;font-size:16px;margin-bottom:2px}
.block{border-top:1px solid var(--border);margin-top:12px;padding-top:10px}
.block .label{font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);margin-bottom:6px}
.block p{font-size:13px;line-height:1.55}
.block.health.ok{border-left:3px solid var(--up);padding-left:10px}
.block.health.risk{border-left:3px solid var(--down);padding-left:10px}
.block.health.mixed{border-left:3px solid var(--warn);padding-left:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.stat{border:1px solid var(--border);border-radius:8px;padding:9px}
.stat .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
.stat .v{font-size:15px;font-variant-numeric:tabular-nums;margin-top:3px}

.legend{margin-top:14px;font-size:12px;color:var(--muted)}
.legend summary{cursor:pointer;padding:6px 0}
.legend p{margin:6px 0;line-height:1.5}
footer{margin-top:14px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between}
body.stale-data .matrix{opacity:.45}
@media (prefers-reduced-motion:no-preference){
  .updating{animation:pulse .8s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.5}}
}
```

- [ ] **Step 4: Verify it serves**

Run the dev server via the `dashboard` config in `.claude/launch.json`, open the preview, and confirm the header, weather strip and legend render with no console errors. The matrix is empty at this point — that is expected.

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css src/format.js
git commit -m "Rebuild page shell with external stylesheet and formatters"
```

---

## Task 14: Worker API client with fan-out

**Files:**
- Create: `src/api.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `WORKER_URL: string`
  - `fetchAsset(base, opts) -> Promise<object>` where `opts = { deep?:boolean, etf?:string|null }`
  - `fetchMacro() -> Promise<object>`
  - `fetchMatrix(watchlist, opts, onRow) -> Promise<void>` — calls `onRow(base, { ok, data, err })` as each settles

- [ ] **Step 1: Write the client**

`src/api.js`:

```js
const params = new URLSearchParams(location.search);
if (params.get('api')) localStorage.setItem('ppd_api', params.get('api'));

export const WORKER_URL = params.get('api')
  || localStorage.getItem('ppd_api')
  || 'https://perp-pulse-data.perp-pulse-data.workers.dev';

const TIMEOUT_MS = 8000;

async function get(path, search) {
  const url = new URL(WORKER_URL);
  url.pathname = path;
  for (const [k, v] of Object.entries(search)) if (v != null) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json();
    if (r.status === 429) throw new Error('rate limited — backing off');
    if (!r.ok || body.error) throw new Error(body.detail || body.error || `HTTP ${r.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchAsset = (base, { deep = false, etf = null } = {}) =>
  get('/asset', { symbol: base, deep: deep ? 1 : null, etf });

export const fetchMacro = () => get('/macro', {});

/**
 * Fan out one request per asset. Deliberately NOT a single /matrix call: a
 * Worker invocation is capped at 50 subrequests, and one slow venue must not
 * blank the whole grid. Each row paints as it settles.
 */
export async function fetchMatrix(watchlist, opts, onRow) {
  await Promise.all(watchlist.map(async (base) => {
    try {
      onRow(base, { ok: true, data: await fetchAsset(base, opts) });
    } catch (e) {
      onRow(base, { ok: false, err: e.message });
    }
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api.js
git commit -m "Add Worker API client with per-asset fan-out"
```

---

## Task 15: Phase 1 matrix render

**Files:**
- Create: `src/matrix.js`

**Interfaces:**
- Consumes: `src/format.js` (Task 13)
- Produces:
  - `renderRow(base, result) -> HTMLElement`
  - `sortRows(container)` — reorders by `|score|` descending
  - `scoreChips(layers) -> HTMLElement`

- [ ] **Step 1: Write the renderer**

`src/matrix.js`:

```js
import { fmtPct, fmtPrice, fmtScore, signClass } from './format.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** The five §VII layers, always shown together — a total alone isn't actionable. */
export function scoreChips(layers) {
  const box = el('div', 'chips');
  for (const l of layers) {
    const c = el('span', 'chip ' + signClass(l.value));
    c.textContent = `${l.label} ${fmtScore(l.value)}`;
    c.title = l.detail;
    if (l.proxy) {
      const p = el('span', 'pxy', 'proxy');
      p.title = 'BTC ETF flow used as a macro proxy — not asset-specific';
      c.appendChild(p);
    }
    box.appendChild(c);
  }
  return box;
}

export function renderRow(base, result) {
  const row = el('div', 'row');
  row.dataset.symbol = base;

  if (!result.ok) {
    // One dead venue degrades ONE row. The rest of the grid still paints.
    row.classList.add('err');
    row.dataset.score = '0';
    const top = el('div', 'row-top');
    top.append(el('span', 'tkr', base), el('span', 'vd', result.err));
    row.append(top);
    return row;
  }

  const d = result.data;
  const s = d.score;
  row.classList.add(s.cls);
  row.dataset.score = String(Math.abs(s.total));

  const top = el('div', 'row-top');
  top.append(
    el('span', 'tkr', base),
    el('span', 'score ' + signClass(s.total), fmtScore(s.total)),
    el('span', 'vd', s.verdict),
  );
  const px = el('span', 'px');
  px.innerHTML = `${fmtPrice(d.price.mark)} <span class="${signClass(d.price.chg1h)}">${fmtPct(d.price.chg1h)}</span>`;
  top.append(px);

  const eq = d.signals.equilibrium;
  const mid = el('div', 'row-mid');
  mid.append(
    el('span', null, eq ? `${eq.zone} · ${fmtPct(eq.pctToLow)} above 4H low` : 'no range data'),
    el('span', signClass(d.oi.d1h), `OI ${d.oi.d1h >= 0 ? '↑' : '↓'} ${fmtPct(d.oi.d1h)}`),
    el('span', signClass(-d.funding.rate), `Fund ${d.funding.rate >= 0 ? '↑' : '↓'} ${d.funding.rate.toFixed(4)}%`),
  );

  const bot = el('div', 'row-bot');
  const f = d.signals.fvg;
  bot.append(el('span', 'badge', f
    ? `${f.type === 'bull' ? 'Bull' : 'Bear'} FVG ${f.distPct.toFixed(2)}%`
    : 'No-Man’s Land'));
  bot.append(el('span', 'badge', d.signals.mode.mode === 'TREND'
    ? `TREND ${d.signals.mode.direction > 0 ? '↑' : '↓'}` : 'RANGE'));
  if (d.signals.sweep.layer !== 0 || d.signals.sweep.label === 'both swept') {
    bot.append(el('span', 'badge hot', d.signals.sweep.label));
  }
  // Unscored OI quadrants are surfaced here rather than moving the score.
  const oiDetail = s.layers.find((l) => l.key === 'oi').detail;
  if (oiDetail === 'fresh shorts' || oiDetail === 'short covering') {
    bot.append(el('span', 'badge hot', oiDetail));
  }

  row.append(top, mid, bot, scoreChips(s.layers));
  return row;
}

/** Extremes float to the top; CHOPPY sinks. That is the radar's whole job. */
export function sortRows(container) {
  [...container.children]
    .sort((a, b) => (+b.dataset.score || 0) - (+a.dataset.score || 0))
    .forEach((n) => container.appendChild(n));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/matrix.js
git commit -m "Add Phase 1 matrix row rendering"
```

---

## Task 16: Phase 2 detail panel and Binance enrichment

**Files:**
- Create: `src/detail.js`
- Create: `src/binance-enrich.js`

**Interfaces:**
- Consumes: `src/format.js`, `scoreChips` from `src/matrix.js`
- Produces:
  - `renderDetail(node, data)` — paints the Phase 2 panel
  - `enrichBinance(data, isCurrent) -> Promise<boolean>` — resolves true if anything was enriched

- [ ] **Step 1: Write the detail panel**

`src/detail.js`:

```js
import { fmtPct, fmtPrice, fmtCoin, fmtUsd, countdown } from './format.js';
import { scoreChips } from './matrix.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const stat = (k, v, sub) => {
  const s = el('div', 'stat');
  s.append(el('div', 'k', k), el('div', 'v', v));
  if (sub) s.append(el('div', 'k', sub));
  return s;
};

export function renderDetail(node, d) {
  node.innerHTML = '';
  node.hidden = false;

  node.append(el('h2', null, `${d.symbol} · ${fmtPrice(d.price.mark)}`));

  // BLOCK 1 — Phase 1 bias. Labelled with the question it answers, because
  // it can legitimately disagree with the health block below.
  const bias = el('div', 'block');
  bias.append(el('div', 'label', `Bias (§VII) — ${d.score.verdict} ${d.score.total >= 0 ? '+' : ''}${d.score.total}`));
  bias.append(scoreChips(d.score.layers));
  node.append(bias);

  // BLOCK 2 — Phase 2 health. NEVER summed with the bias score.
  if (d.health) {
    const h = el('div', 'block health ' + d.health.cls);
    h.append(el('div', 'label', 'Pullback health — is this absorption or a knife?'));
    h.append(el('p', null, d.health.msg));
    node.append(h);
  }

  const m = el('div', 'block');
  m.append(el('div', 'label', 'Market'));
  const g = el('div', 'grid');
  g.append(
    stat('Funding', d.funding.rate.toFixed(4) + '%', `annualized ~${(d.funding.rate * 3 * 365).toFixed(1)}%`),
    stat('Next funding', countdown(d.funding.nextFundingTime)),
    stat('Open interest', fmtCoin(d.oi.aggCoin ?? d.oi.coin) + ' ' + d.symbol,
      fmtUsd(d.oi.aggUsd ?? d.oi.usd)),
    stat('OI Δ 1h / 4h', `${fmtPct(d.oi.d1h)} / ${fmtPct(d.oi.d4h)}`),
    stat('Taker buy/sell', d.positioning?.taker == null ? 'n/a' : d.positioning.taker.toFixed(3), '1h aggressor flow'),
    stat('Long / short', d.positioning?.topLS == null ? 'n/a' : d.positioning.topLS.toFixed(3), d.positioning?.source ?? ''),
  );
  m.append(g);
  node.append(m);

  if (d.book) {
    const b = el('div', 'block');
    const cov = Math.max(d.book.ask.coveredPct || 0, d.book.bid.coveredPct || 0);
    b.append(el('div', 'label', `Order-book walls · ±${cov.toFixed(2)}% · ${d.book.source ?? ''}`));
    const side = (name, s) => {
      const w = s.nearestWall;
      return el('p', null, w
        ? `${name}: ${fmtPrice(w.price)} (${fmtPct(w.distPct)}) · ${fmtCoin(w.size)} ${d.symbol}`
        : `${name}: smooth — no distinct wall`);
    };
    b.append(side('Ask', d.book.ask), side('Bid', d.book.bid),
      el('p', null, `Resting ${Math.round(d.book.imbalancePct)}% bid / ${100 - Math.round(d.book.imbalancePct)}% ask`));
    node.append(b);
  }
}
```

- [ ] **Step 2: Extract the Binance enrichment**

`src/binance-enrich.js`:

```js
/**
 * Hybrid enrichment. Binance is geo-blocked from the Worker's edge, but the
 * USER's device (phone, VPN) often reaches it. So after the OKX/Bybit baseline
 * paints, try Binance directly from the browser. On a blocked network these
 * abort fast and the baseline simply stands.
 */
const BINANCE = 'https://fapi.binance.com';

async function jTimeout(url, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * @param {object} d        the deep asset payload
 * @param {() => boolean} isCurrent  false if the user has since switched pair
 * @returns {Promise<boolean>} whether anything was enriched
 */
export async function enrichBinance(d, isCurrent) {
  const S = d.symbol + 'USDT';
  let touched = false;

  try {
    const oi = await jTimeout(`${BINANCE}/fapi/v1/openInterest?symbol=${S}`);
    if (!isCurrent()) return false;
    d.oi.venues = { ...(d.oi.venues ?? {}), binance: +oi.openInterest };
    d.oi.aggCoin = Object.values(d.oi.venues).filter((v) => v != null).reduce((s, v) => s + v, 0);
    d.oi.aggUsd = d.oi.aggCoin * d.price.mark;
    touched = true;
  } catch { /* blocked network — expected */ }

  try {
    const [taker, topls] = await Promise.all([
      jTimeout(`${BINANCE}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
      jTimeout(`${BINANCE}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
    ]);
    if (!isCurrent()) return touched;
    d.positioning = {
      taker: +taker[0].buySellRatio,
      topLS: +topls[0].longShortRatio,
      source: 'Binance top-trader (direct)',
    };
    touched = true;
  } catch { /* blocked network — expected */ }

  return touched;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/detail.js src/binance-enrich.js
git commit -m "Add Phase 2 detail panel and extract Binance enrichment"
```

---

## Task 17: Market weather widget and ETF toggle

**Files:**
- Create: `src/weather.js`

**Interfaces:**
- Consumes: `src/format.js`
- Produces:
  - `renderWeather(macro)` — paints BTC.D / USDT.D / TOTAL3
  - `initEtfToggle(onChange) -> { get(): string|null, refresh(macro): void }`

- [ ] **Step 1: Write the widget**

`src/weather.js`:

```js
import { fmtUsd } from './format.js';

/**
 * Display-only macro context. Dominance MUST NOT enter the §VII score — the
 * PRD is explicit and the scoring table has no dominance row. Styled muted
 * (dashed border, no traffic lights) so it never reads as a signal.
 */
export function renderWeather(macro) {
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('w-btcd', macro?.btcD == null ? '—' : macro.btcD.toFixed(1) + '%');
  set('w-usdtd', macro?.usdtD == null ? '—' : macro.usdtD.toFixed(2) + '%');
  set('w-total3', macro?.total3 == null ? '—' : fmtUsd(macro.total3));
}

const CYCLE = [null, 'in', 'out', 'flat'];
const LABEL = { in: 'ETF IN', out: 'ETF OUT', flat: 'ETF FLAT' };

/**
 * ETF flow is score layer 1 and its feed is unreliable. When the Worker cannot
 * read it, this lets the value be set by hand — but the choice is sent BACK to
 * the Worker as ?etf=, so scoring still happens server-side in one place.
 */
export function initEtfToggle(onChange) {
  const btn = document.getElementById('etf-toggle');
  let manual = localStorage.getItem('ppd_etf') || null;

  const paint = (auto) => {
    if (manual) { btn.textContent = LABEL[manual] + ' ·'; return; }
    btn.textContent = auto == null ? 'ETF —' : 'ETF ' + fmtUsd(auto);
  };

  btn.addEventListener('click', () => {
    manual = CYCLE[(CYCLE.indexOf(manual) + 1) % CYCLE.length];
    if (manual) localStorage.setItem('ppd_etf', manual);
    else localStorage.removeItem('ppd_etf');
    paint(null);
    onChange();
  });

  paint(null);
  return {
    get: () => manual,
    refresh: (macro) => paint(macro?.etfBtc ?? null),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/weather.js
git commit -m "Add market weather widget and manual ETF toggle"
```

---

## Task 18: Boot, refresh loop, staleness and watchlist

**Files:**
- Create: `src/main.js`

**Interfaces:**
- Consumes: everything from Tasks 13–17
- Produces: application entry point

- [ ] **Step 1: Write the entry point**

`src/main.js`:

```js
import { fetchMatrix, fetchAsset, fetchMacro } from './api.js';
import { renderRow, sortRows } from './matrix.js';
import { renderDetail } from './detail.js';
import { renderWeather, initEtfToggle } from './weather.js';
import { enrichBinance } from './binance-enrich.js';

const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB'];
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;

const params = new URLSearchParams(location.search);
if (params.get('watchlist')) {
  localStorage.setItem('ppd_watchlist', params.get('watchlist').toUpperCase());
}
const watchlist = (localStorage.getItem('ppd_watchlist') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const WATCHLIST = watchlist.length ? watchlist : DEFAULT_WATCHLIST;

const $ = (id) => document.getElementById(id);
let lastGood = 0;
let openSymbol = null;
let timer = null;

const etf = initEtfToggle(() => load());

function showError(msg) {
  $('err').hidden = !msg;
  $('err').textContent = msg || '';
}

/**
 * Showing 40-minute-old prices as if they were live is the worst failure this
 * tool can have — you would size a position off a number that no longer
 * exists. So staleness is loud and the grid dims.
 */
function checkStale() {
  const age = Date.now() - lastGood;
  const stale = lastGood > 0 && age > STALE_MS;
  $('stale').hidden = !stale;
  document.body.classList.toggle('stale-data', stale);
  if (stale) {
    $('stale').textContent =
      `Data is ${Math.floor(age / 60000)} min old — the last refresh failed. Do not trade off these numbers.`;
  }
}

async function openDetail(symbol) {
  openSymbol = symbol;
  const node = $('detail');
  node.hidden = false;
  node.textContent = 'Loading…';
  try {
    const d = await fetchAsset(symbol, { deep: true, etf: etf.get() });
    if (openSymbol !== symbol) return;
    renderDetail(node, d);
    // Non-blocking: enrich from the user's own network if it can reach Binance.
    if (await enrichBinance(d, () => openSymbol === symbol)) renderDetail(node, d);
  } catch (e) {
    node.textContent = `Could not load ${symbol}: ${e.message}`;
  }
}

async function load() {
  const btn = $('refresh');
  btn.disabled = true;
  document.body.classList.add('updating');
  showError('');

  const matrix = $('matrix');
  const rows = new Map();
  let anyOk = false;

  const macroPromise = fetchMacro().catch(() => null);

  await fetchMatrix(WATCHLIST, { etf: etf.get() }, (base, res) => {
    if (res.ok) anyOk = true;
    const node = renderRow(base, res);
    node.addEventListener('click', () => openDetail(base));
    const prev = rows.get(base);
    if (prev) prev.replaceWith(node); else matrix.appendChild(node);
    rows.set(base, node);
  });
  sortRows(matrix);

  const macro = await macroPromise;
  renderWeather(macro);
  etf.refresh(macro);

  if (anyOk) {
    lastGood = Date.now();
    $('ts').textContent = new Date().toLocaleTimeString();
    $('src').textContent = `${WATCHLIST.length} assets · Bybit core`;
  } else {
    showError('Could not reach the data proxy. Set it once with ?api=<worker-url>.');
  }

  checkStale();
  btn.disabled = false;
  document.body.classList.remove('updating');
}

function schedule() {
  clearInterval(timer);
  // §II says the charts are closed most of the day — a hidden tab should not
  // burn request quota or phone battery.
  if (document.hidden) return;
  timer = setInterval(load, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  schedule();
  if (!document.hidden) load();
});
$('refresh').addEventListener('click', () => load());
setInterval(checkStale, 30_000);

load();
schedule();
```

- [ ] **Step 2: Verify end to end**

Start the dev server (`dashboard` in `.claude/launch.json`) and, in a second terminal, `cd worker && npx wrangler dev --port 8787`. Open the preview at `?api=http://127.0.0.1:8787`.

Confirm:
- Eight rows render, each with a score, verdict and five chips.
- Rows are ordered by `|score|` descending.
- Tapping a row opens the detail panel with **separate** "Bias (§VII)" and "Pullback health" blocks.
- The console is clean.
- Killing the Worker and hitting Refresh shows the error banner rather than a blank grid.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "Add app entry point with refresh loop and staleness guard"
```

---

## Task 19: Update project documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-19-perp-pulse-rebuild-design.md`

`CLAUDE.md` currently documents a single-pair dashboard with all logic in one Worker file and `oi.btc` in the payload. All three are now wrong.

- [ ] **Step 1: Update `CLAUDE.md`**

Rewrite these sections:
- **Architecture** — add the `/asset` + `/macro` endpoints and the fan-out rationale (50-subrequest cap).
- **File map** — replace "single-file dashboard" with the `src/` module list; replace "`worker/src/index.js`" with the `compute/` + `sources/` split.
- **Single source of truth** — state that `score.js` (§VII bias, Phase 1) and `verdict.js` (pullback health, Phase 2) are two engines answering different questions and are never summed. Note the Telegram worker must import `verdict.js`.
- **Pairs** — record that `DEFAULT_WATCHLIST` is playbook §II's eight, that `PAIRS` is wider, and that `ppd_watchlist` overrides it.
- **Data scope** — add EMA34, equilibrium, FVG, sweep, mode, dominance; rename `oi.btc` to `oi.coin`.
- **Verdict thresholds** — point at `THRESHOLDS` in `score.js` as the single place to tune.
- **Known limits** — add: ETF flow is unreliable and may sit at 0; dominance is display-only; the daily kline keeps its unclosed candle on purpose; the PDH/PDL day boundary is UTC, not WIB.

- [ ] **Step 2: Amend the spec where implementation diverged**

In `docs/superpowers/specs/2026-08-19-perp-pulse-rebuild-design.md`, update §3.2/§4 to record that `chg1h` comes from Bybit's `prevPrice1h` ticker field and `chg4h` moved to the `deep=1` path — this is what keeps the shallow route at exactly four calls.

- [ ] **Step 3: Run the full suite one last time**

Run: `cd worker && npm test`
Expected: PASS — 63 tests

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-19-perp-pulse-rebuild-design.md
git commit -m "Update project docs for the Phase 1 radar architecture"
```

---

## Deferred to a later milestone

- **§III 5-pillar gate.** `equilibrium()` (pillar 2), `marketMode()` + BOS direction (pillar 1) and `sweepState()` (pillar 5) already emit everything needed. Pillars 3 and 4 need manual checkboxes with persisted state.
- **TradingView → Telegram push worker.** Must import `verdict.js`, never reimplement it.
- **Verifying venue coverage** for HYPE, WLD, RENDER, ZEC, ONDO, ASTER, JTO before those pairs are relied on.
