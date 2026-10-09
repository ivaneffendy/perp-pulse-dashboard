# Candidates Pre-screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Candidates section to the Movers tab that lists liquid coins whose 4H structure is trending and whose price has pulled back into the value half of the anchored leg.

**Architecture:** A pure `compute/anchored.js` computes the anchored range from closed 4H bars. A new `GET /candidates` Worker route picks the universe from one tickers call, fetches 4H klines per coin on the same venue, and returns sorted items. A pure `src/candidates.js` renders them above the existing Movers list.

**Tech Stack:** Cloudflare Worker (plain ES modules, no deps), Node 22 `node:test`, static GitHub Pages front end with no build step.

**Spec:** `docs/superpowers/specs/2026-10-09-candidates-screener-design.md`

## Global Constraints

- Swing width **3**. Anchors are **wicks**. Structure uses **closed bars only** (`normalizeKlines` already drops the forming bar).
- Universe: `turnover24h ≥ 100_000_000`, ∩ `?top100=`, − `?exclude=`, capped at **20** by turnover. BTC is a candidate (not a baseline here).
- Every kline request goes to the venue that served the tickers, with `retry: false`.
- Status values exactly: `in_zone`, `outside`, `broken`, `unclear`, `error`.
- `anchored.js` and `candidates.js` must never be referenced by `score.js`, `verdict.js`, `compute/absorption.js` or `compute/regime.js`.
- Public repo: no trade prices, position sizes, risk figures or journal references in code, tests, fixtures or comments. Pair names are fine.
- `/movers` response items keep exactly `base, pct24h, rel, turnover24h`.
- `protected` is a legal property name but a reserved word in strict mode. Never destructure it (`const { protected } = …` is a SyntaxError). Use `item.protected`.
- Write every repo file through the Edit/Write tools, never via shell redirection, `sed -i` or scripts. Exception: copying the downloaded market-data fixture with `cp`.
- Tests: `cd worker && npm test`. Baseline before this plan: 200 pass.

## Review Focus

1. **`last` leaking into `/movers`.** Adding `last` to tickers would silently add a key to every Movers item, because `rankMovers` spreads `...x`. Expect Movers' shape unchanged. Pinned in Task 1 by the existing exact-keys test, run against tickers that now carry `lastPrice`.
2. **Bybit geo-block in the middle of the 20-coin kline fan-out.** The fetcher's retry ladder would multiply calls past the 50-subrequest cap. Expect a 200 with every coin `error`, and at most 21 upstream calls. Pinned in Task 3.
3. **A listed coin with too little 4H history, or a venue answering with no bars.** Expect `unclear` or `error` on that row, never a thrown route. Pinned in Tasks 2 and 3.
4. **Upstream error text reaching `innerHTML`.** `detail` carries up to 180 chars of an exchange's raw body. Expect it never rendered. Pinned in Task 4.
5. **No top-100 list (the market-cap vendor failed).** Expect non-crypto listings like XAU to appear *and* a visible warning banner, not an empty or silently unfiltered list. Pinned in Tasks 3 and 4.

---

### Task 1: Tickers carry `last`; Movers items keep their shape

**Files:**
- Modify: `worker/src/sources/bybit.js` (inside `bybitTickers`)
- Modify: `worker/src/sources/okx.js` (inside `okxTickers`)
- Modify: `worker/src/compute/movers.js` (the `.map` in `rankMovers`)
- Modify: `worker/test/movers-route.test.js` (`bybitList`)
- Create: `worker/test/tickers.test.js`

**Interfaces:**
- Produces: `bybitTickers(j)` / `okxTickers(j)` → `{ source, tickers: { base, pct24h, turnover24h, last }[] }`. `last` is a number (it may be `NaN` if the venue omits it, and is not filtered on).

- [ ] **Step 1: Make the Movers fixture realistic.** In `worker/test/movers-route.test.js`, replace `bybitList` with:

```js
const bybitList = () => [
  { symbol: 'BTCUSDT', price24hPcnt: '0.01', turnover24h: '900000000', lastPrice: '84000' },
  { symbol: 'ARBUSDT', price24hPcnt: '0.22', turnover24h: '80000000', lastPrice: '0.41' },
  { symbol: 'DUSTUSDT', price24hPcnt: '0.90', turnover24h: '10000', lastPrice: '0.001' }, // below floor
  { symbol: 'BTCPERP', price24hPcnt: '0.01', turnover24h: '900000000', lastPrice: '84000' }, // not USDT-suffixed
];
```

- [ ] **Step 2: Write the failing ticker tests.** Create `worker/test/tickers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bybitTickers } from '../src/sources/bybit.js';
import { okxTickers } from '../src/sources/okx.js';

test('bybitTickers passes the last price through as a number', async () => {
  const { tickers } = await bybitTickers(async () => ({
    result: { list: [{ symbol: 'SOLUSDT', price24hPcnt: '0.02', turnover24h: '500000000', lastPrice: '112.4' }] },
  }));
  assert.equal(tickers[0].last, 112.4);
});

test('okxTickers passes the last price through as a number', async () => {
  const { tickers } = await okxTickers(async () => ({
    data: [{ instId: 'SOL-USDT-SWAP', open24h: '110', last: '112.4', volCcy24h: '5000000' }],
  }));
  assert.equal(tickers[0].last, 112.4);
});
```

- [ ] **Step 3: Run and see them fail.**

Run: `cd worker && npm test`
Expected: the two `tickers.test.js` tests FAIL (`undefined !== 112.4`). Everything else passes.

- [ ] **Step 4: Add `last` to both venues.** In `bybitTickers`, change the map to:

```js
    .map((t) => ({
      base: t.symbol.replace(/USDT$/, ''),
      pct24h: +t.price24hPcnt * 100,
      turnover24h: +t.turnover24h,
      last: +t.lastPrice,
    }))
```

In `okxTickers`, change the returned object to:

```js
      return {
        base: t.instId.replace(/-USDT-SWAP$/, ''),
        pct24h: open ? (last / open - 1) * 100 : NaN,
        turnover24h: volCcy * last,
        last,
      };
```

- [ ] **Step 5: Run and see the Movers shape break.**

Run: `cd worker && npm test`
Expected: the `tickers.test.js` tests PASS. `movers-route.test.js` › "response item keys are exactly the documented shape…" FAILS because `last` is now in the keys. That is Review Focus 1, caught.

- [ ] **Step 6: Pin the Movers item shape.** In `worker/src/compute/movers.js`, replace `.map((x) => ({ ...x, rel: x.pct24h - btcPct }))` with:

```js
    // Explicit keys, not a spread: tickers carry more than Movers shows
    // (`last`, for /candidates), and every extra key would leak into this
    // awareness-only response.
    .map((x) => ({
      base: x.base, pct24h: x.pct24h, turnover24h: x.turnover24h,
      rel: x.pct24h - btcPct,
    }))
```

- [ ] **Step 7: Run all tests.**

Run: `cd worker && npm test`
Expected: all pass (202).

- [ ] **Step 8: Commit.**

```bash
git add worker/src/sources/bybit.js worker/src/sources/okx.js worker/src/compute/movers.js worker/test/movers-route.test.js worker/test/tickers.test.js
git commit -m "tickers: carry last price; pin /movers item keys so it cannot leak"
```

---

### Task 2: `compute/anchored.js`, the anchored range

**Files:**
- Create: `worker/src/compute/anchored.js`
- Create: `worker/test/anchored.test.js`
- Create: `worker/test/fixtures/btc-4h-2026-10-07.json` (copied market data)

**Interfaces:**
- Produces:
  - `ANCHORED = { swingWidth: 3, minBars: 20 }`
  - `swings(bars, w) → { highs: number[], lows: number[] }` (bar indices)
  - `anchoredRange(bars, last, opts = ANCHORED) → { side: 'long'|'short'|null, protected: number|null, extreme: number|null, pctOfRange: number|null, distToProtectedPct: number|null, bosAgeBars: number|null, status: 'in_zone'|'outside'|'broken'|'unclear' }`
  - `bars` are closed 4H bars `{ h, l, c, … }`, oldest first. `pctOfRange` runs 0 at the range low to 100 at the range high. `distToProtectedPct = (protected / last − 1) × 100`, which is negative for a long and positive for a short.

- [ ] **Step 1: Add the fixture.** It's real BTCUSDT 4H Bybit klines ending 2026-10-07 02:42:21Z, newest-first, with the forming bar first. It was downloaded during design to the session scratchpad.

```bash
cp /private/tmp/claude-502/-Users-ivan-halim-Repo-Personal-trading-vault/556229b3-0b66-48b7-b80b-5a9be00f8755/scratchpad/data/btc4h.json worker/test/fixtures/btc-4h-2026-10-07.json
```

If that file is gone, re-download it (Bybit public API, no key):

```bash
curl -s "https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=240&end=1791340941000&limit=200" -o worker/test/fixtures/btc-4h-2026-10-07.json
```

Check: `node -e "const r=require('./worker/test/fixtures/btc-4h-2026-10-07.json').result.list;console.log(r.length, r[0][0], r[0][4])"` prints `200 1791331200000 84123.2`.

- [ ] **Step 2: Write the failing tests.** Create `worker/test/anchored.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anchoredRange, swings, ANCHORED } from '../src/compute/anchored.js';
import { normalizeKlines, INTERVAL_4H } from '../src/compute/klines.js';

const mk = (rows) => rows.map(([h, l, c]) => ({ o: c, h, l, c }));
const OPTS = { swingWidth: 3, minBars: 10 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// Swing high 110 at i3, swing low 90 at i6, close 112 > 110 at i10 (up-BOS,
// protected low 90), swing high 120 at i11, pullback to 104.
const A = [
  [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
  [106, 100, 101], [104, 95, 96], [100, 90, 92], [104, 93, 103],
  [108, 100, 107], [109, 104, 108], [113, 107, 112], [120, 111, 118],
  [118, 112, 114], [116, 108, 109], [112, 104, 105],
];

test('an up-BOS anchors from the leg-origin wick low to the latest high', () => {
  const r = anchoredRange(mk(A), 104, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.extreme, 120);
  close(r.pctOfRange, (104 - 90) / 30 * 100);
  assert.equal(r.status, 'in_zone');
  assert.equal(r.bosAgeBars, 4);
  close(r.distToProtectedPct, (90 / 104 - 1) * 100);
});

test('a long above 50% of the range is outside', () => {
  const r = anchoredRange(mk(A), 112, OPTS);
  assert.equal(r.status, 'outside');
  close(r.pctOfRange, (112 - 90) / 30 * 100);
});

test('a live price beyond the extreme extends it rather than going past 100%', () => {
  const r = anchoredRange(mk(A), 125, OPTS);
  assert.equal(r.extreme, 125);
  close(r.pctOfRange, 100);
  assert.equal(r.status, 'outside');
});

test('a live price through the protected low is broken, still long until a bar closes', () => {
  const r = anchoredRange(mk(A), 89, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.status, 'broken');
});

test('a wick through the protected low without a close does not flip', () => {
  const r = anchoredRange(mk([...A, [106, 88, 95]]), 95, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.status, 'in_zone');
});

test('a body close through the protected low flips short, anchored at the leg high', () => {
  const r = anchoredRange(mk([...A, [106, 85, 87]]), 87, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 120);
  assert.equal(r.extreme, 85);
  assert.equal(r.bosAgeBars, 0);
  assert.equal(r.status, 'outside'); // 5.7% of the range: not premium
});

test('closing below an internal swing low above the protected low is not a break', () => {
  // Swing low 104 at i14 becomes known at i18; i18 closes 101 below it, above 90.
  const r = anchoredRange(mk([...A,
    [108, 105, 107], [110, 106, 109], [111, 107, 110], [109, 100, 101],
  ]), 101, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.status, 'in_zone');
});

test('a new with-trend BOS re-anchors to the new leg origin', () => {
  // Swing high 120 at i11 known from i15; i18 closes 122 above it.
  const r = anchoredRange(mk([...A,
    [112, 100, 102], [115, 101, 114], [119, 110, 118], [124, 117, 122],
  ]), 122, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 100);
  assert.equal(r.extreme, 124);
  assert.equal(r.bosAgeBars, 0);
});

test('one close clearing two swing highs breaks both, so the protected low cannot slide back', () => {
  // Highs 110 (i3) and 108 (i9); lows 95 (i6) and 98 (i12). i15 closes 112,
  // above both. Without marking both, i16's close of 114 would "break" 110
  // again and re-anchor at 95.
  const B = [
    [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
    [106, 99, 100], [104, 97, 98], [101, 95, 97], [103, 96, 102],
    [105, 98, 104], [108, 101, 106], [106, 100, 101], [104, 99, 100],
    [102, 98, 99], [104, 99, 103], [107, 101, 106], [113, 105, 112],
    [115, 110, 114],
  ];
  const r = anchoredRange(mk(B), 114, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 98);
  assert.equal(r.bosAgeBars, 1);
});

test('the short side mirrors the long side', () => {
  const mirror = A.map(([h, l, c]) => [200 - l, 200 - h, 200 - c]);
  const r = anchoredRange(mk(mirror), 96, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 110);
  assert.equal(r.extreme, 80);
  close(r.pctOfRange, (96 - 80) / 30 * 100);
  assert.equal(r.status, 'in_zone');
  close(r.distToProtectedPct, (110 / 96 - 1) * 100);
});

test('width 3 needs three lower bars on each side; width 2 does not', () => {
  const hs = [1, 2, 3, 9, 4, 5, 10, 1, 1, 1];
  const bars = hs.map((h) => ({ o: h, h, l: h - 1, c: h - 0.5 }));
  assert.deepEqual(swings(bars, 3).highs, [6]);
  assert.deepEqual(swings(bars, 2).highs, [3, 6]);
});

test('no break of structure in the window is unclear', () => {
  const flat = Array.from({ length: 25 }, () => [101, 99, 100]);
  assert.equal(anchoredRange(mk(flat), 100).status, 'unclear');
});

test('fewer than the default 20 bars is unclear', () => {
  assert.equal(ANCHORED.minBars, 20);
  assert.equal(anchoredRange(mk(A), 104).status, 'unclear');
});

test('a non-finite live price or a non-array input is unclear, not a throw', () => {
  assert.equal(anchoredRange(mk(A), NaN, OPTS).status, 'unclear');
  assert.equal(anchoredRange(null, 104, OPTS).status, 'unclear');
});

test('regression: BTC 4H ending 2026-10-07 02:42Z', () => {
  const raw = JSON.parse(readFileSync(
    new URL('./fixtures/btc-4h-2026-10-07.json', import.meta.url), 'utf8')).result.list;
  const bars = normalizeKlines(raw, INTERVAL_4H, Date.parse('2026-10-07T02:42:21Z'));
  const last = +raw[0][4]; // the forming bar's close is the live price
  const r = anchoredRange(bars, last);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 83107.7);
  assert.equal(r.extreme, 87242.2);
  assert.equal(r.pctOfRange.toFixed(1), '24.6');
  assert.equal(r.status, 'in_zone');
});

test('anchored and candidates are never referenced by the scoring engines', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(!/anchored|candidates/i.test(src),
      `${p} references the candidates pre-screen — it must never enter scoring`);
  }
});
```

- [ ] **Step 3: Run and see them fail.**

Run: `cd worker && npm test`
Expected: `anchored.test.js` fails to load (`Cannot find module '../src/compute/anchored.js'`).

- [ ] **Step 4: Implement.** Create `worker/src/compute/anchored.js`:

```js
/**
 * Anchored 4H swing range — a PRE-SCREEN for /candidates, never a score.
 *
 * The range runs from the PROTECTED POINT to the LATEST EXTREME of the current
 * 4H leg (spec: docs/superpowers/specs/2026-10-09-candidates-screener-design.md
 * §1). Uptrend: from the swing low that produced the last body-close break of
 * structure up to the highest high since. It re-anchors only on a new
 * body-close break. Unlike equilibrium.js's rolling 30-bar window it never
 * follows price down a leg: a rolling window re-enters "discount" of each
 * lower range, which is the defect this exists to avoid.
 *
 * Never imported by score.js, verdict.js, absorption.js or regime.js —
 * guarded by source inspection in test/anchored.test.js.
 */
export const ANCHORED = { swingWidth: 3, minBars: 20 };

const UNCLEAR = Object.freeze({
  side: null, protected: null, extreme: null, pctOfRange: null,
  distToProtectedPct: null, bosAgeBars: null, status: 'unclear',
});

/**
 * Fractal swings: bar i is a swing high when its high is strictly above the
 * highs of the `w` bars on each side (lows mirrored). Strict, so a flat run of
 * equal bars produces no swing at all.
 */
export function swings(bars, w) {
  const highs = [], lows = [];
  for (let i = w; i < bars.length - w; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= w; k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h > bars[i + k].h)) isH = false;
      if (!(bars[i].l < bars[i - k].l && bars[i].l < bars[i + k].l)) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

const lowestIdx = (bars, a, b) => {
  let p = a;
  for (let k = a + 1; k <= b; k++) if (bars[k].l < bars[p].l) p = k;
  return p;
};
const highestIdx = (bars, a, b) => {
  let p = a;
  for (let k = a + 1; k <= b; k++) if (bars[k].h > bars[p].h) p = k;
  return p;
};

/**
 * One pass over closed bars. Returns `{ side, prot, bos }` (prot and bos are
 * bar indices) after the last bar, or null if no break ever printed.
 *
 * Two kinds of break, and only two:
 * - with-trend: a body close beyond the most recent known, unbroken swing in
 *   the trend's direction (either direction while no side is set yet);
 * - the flip: a body close through the protected point. A close below an
 *   internal swing low that sits above the protected low is NOT a break —
 *   that is the pullback being screened for.
 */
function structure(bars, w) {
  const { highs, lows } = swings(bars, w);
  const brokenH = new Set(), brokenL = new Set();
  // A swing at j is only knowable once its w right-hand bars have closed.
  const known = (idx, broken, i) => idx.filter((j) => j + w < i && !broken.has(j));
  let st = null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    let ev = null;
    if (st?.side === 'long' && c < bars[st.prot].l) {
      ev = { side: 'short', from: st.prot };
    } else if (st?.side === 'short' && c > bars[st.prot].h) {
      ev = { side: 'long', from: st.prot };
    } else {
      if (st?.side !== 'short') {
        const kh = known(highs, brokenH, i);
        const j = kh.at(-1);
        if (j != null && c > bars[j].h) {
          // Mark EVERY swing this close cleared, or the next bars "break"
          // older swings price already left behind and the protected low
          // slides back to an older leg.
          for (const x of kh) if (bars[x].h < c) brokenH.add(x);
          ev = { side: 'long', from: j };
        }
      }
      if (!ev && st?.side !== 'long') {
        const kl = known(lows, brokenL, i);
        const j = kl.at(-1);
        if (j != null && c < bars[j].l) {
          for (const x of kl) if (bars[x].l > c) brokenL.add(x);
          ev = { side: 'short', from: j };
        }
      }
    }
    if (ev) {
      st = {
        side: ev.side,
        bos: i,
        prot: ev.side === 'long' ? lowestIdx(bars, ev.from, i) : highestIdx(bars, ev.from, i),
      };
    }
  }
  return st;
}

/**
 * @param {{h:number,l:number,c:number}[]} bars  CLOSED 4H bars, oldest first
 * @param {number} last  live price (the ticker's last)
 * @param {{swingWidth?:number, minBars?:number}} opts
 */
export function anchoredRange(bars, last, opts = ANCHORED) {
  const { swingWidth: w, minBars } = { ...ANCHORED, ...opts };
  if (!Array.isArray(bars) || bars.length < minBars || !Number.isFinite(last)) return { ...UNCLEAR };
  const st = structure(bars, w);
  if (!st) return { ...UNCLEAR };

  const long = st.side === 'long';
  const prot = long ? bars[st.prot].l : bars[st.prot].h;
  let extreme = last;
  for (let k = st.bos; k < bars.length; k++) {
    extreme = long ? Math.max(extreme, bars[k].h) : Math.min(extreme, bars[k].l);
  }
  const lo = long ? prot : extreme;
  const hi = long ? extreme : prot;
  if (!(hi > lo)) return { ...UNCLEAR };

  const pctOfRange = ((last - lo) / (hi - lo)) * 100;
  const broken = long ? last <= prot : last >= prot;
  const inZone = long ? pctOfRange < 50 : pctOfRange > 50;
  return {
    side: st.side,
    protected: prot,
    extreme,
    pctOfRange,
    distToProtectedPct: (prot / last - 1) * 100,
    bosAgeBars: bars.length - 1 - st.bos,
    status: broken ? 'broken' : inZone ? 'in_zone' : 'outside',
  };
}
```

- [ ] **Step 5: Run all tests.**

Run: `cd worker && npm test`
Expected: all pass (218). If only the regression test fails, check that the fixture's `r[0][0]` is `1791331200000` (Step 1) before touching the algorithm.

- [ ] **Step 6: Commit.**

```bash
git add worker/src/compute/anchored.js worker/test/anchored.test.js worker/test/fixtures/btc-4h-2026-10-07.json
git commit -m "compute: anchored 4H range (protected point -> latest extreme), pre-screen only"
```

---

### Task 3: `GET /candidates`

**Files:**
- Create: `worker/src/compute/candidates.js`
- Modify: `worker/src/index.js` (imports, new `handleCandidates`, one router line)
- Create: `worker/test/candidates-route.test.js`
- Modify: `CLAUDE.md` (architecture diagram and module list)

**Interfaces:**
- Consumes: `anchoredRange`, `ANCHORED` (Task 2); `bybitTickers`/`okxTickers` with `last` (Task 1); the existing `bybitCandles(sym, now, limit, j)` / `okxCandles(sym, now, limit, j)` → `{ source, bars }`; `resolvePair`; `fetcher`; `withFallback`; `json`.
- Produces:
  - `CANDIDATES = { floor: 100_000_000, cap: 20, swingWidth: 3, bars: 200 }`
  - `selectUniverse(tickers, opts, capBases: Set|null, exclude: Set) → tickers[]`
  - `sortCandidates(items) → items[]`
  - `handleCandidates(url) → Response`, with JSON body `{ ts, source, criterion: { turnoverFloor, swingWidth }, universeFiltered, excluded, items }`. Each item is `{ base, turnover24h, last, side, protected, extreme, pctOfRange, distToProtectedPct, bosAgeBars, status, detail? }`.

- [ ] **Step 1: Write the failing tests.** Create `worker/test/candidates-route.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCandidates } from '../src/index.js';

const H4 = 4 * 60 * 60 * 1000;
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// The same up-BOS leg as anchored.test.js's A (protected 90, extreme 120),
// padded with flat bars to clear the default 20-bar minimum. Returned as
// venue rows, newest first, every bar already closed.
const LEG = [
  ...Array.from({ length: 6 }, () => [101, 99, 100]),
  [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
  [106, 100, 101], [104, 95, 96], [100, 90, 92], [104, 93, 103],
  [108, 100, 107], [109, 104, 108], [113, 107, 112], [120, 111, 118],
  [118, 112, 114], [116, 108, 109], [112, 104, 105],
];
const rows = () => {
  const end = Math.floor(Date.now() / H4) * H4;
  return LEG.map(([h, l, c], i) => [
    String(end - (LEG.length - i) * H4), String(c), String(h), String(l), String(c), '1', '1',
  ]).reverse();
};

const bybitT = (symbol, turnover24h, lastPrice) =>
  ({ symbol: `${symbol}USDT`, price24hPcnt: '0.01', turnover24h: String(turnover24h), lastPrice: String(lastPrice) });

const TICKERS = [
  bybitT('BTC', 3e9, 104),   // in zone (46.7%)
  bybitT('ETH', 2e9, 112),   // outside (73.3%)
  bybitT('SOL', 5e8, 89),    // broken (through 90)
  bybitT('XAU', 6e8, 104),   // not in top100
  bybitT('BTW', 2e8, 104),   // excluded
  bybitT('DUST', 5e7, 104),  // below the floor
];

const symbolOf = (u) => new URL(String(u)).searchParams.get('symbol')
  ?? new URL(String(u)).searchParams.get('instId');

/** Records every upstream URL; routes tickers vs klines by path. */
function venue({ tickers = TICKERS, kline = () => ok({ result: { list: rows() } }) } = {}) {
  const calls = [];
  const impl = async (u) => {
    calls.push(String(u));
    if (String(u).includes('/market/tickers')) return ok({ result: { list: tickers } });
    return kline(u);
  };
  return { calls, impl };
}

const CAND = 'https://x.test/candidates?top100=BTC,ETH,SOL,BTW,DUST&exclude=BTW';

test('screens the filtered universe and sorts in_zone, outside, broken', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'Bybit linear');
  assert.deepEqual(b.items.map((x) => x.base), ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(b.items.map((x) => x.status), ['in_zone', 'outside', 'broken']);
  assert.equal(b.items[0].side, 'long');
  assert.equal(b.items[0].protected, 90);
  assert.equal(b.items[0].last, 104);
  assert.equal(b.universeFiltered, true);
  assert.deepEqual(b.excluded, ['BTW']);
  assert.deepEqual(b.criterion, { turnoverFloor: 100_000_000, swingWidth: 3 });
  assert.equal(v.calls.length, 1 + 3, 'one tickers call plus one kline call per coin');
});

test('item keys are exactly the documented shape, with no scoring leakage', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  const raw = await res.text();
  assert.ok(!/score|verdict|layers|bias/i.test(raw));
  for (const item of JSON.parse(raw).items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'base', 'bosAgeBars', 'distToProtectedPct', 'extreme', 'last', 'pctOfRange',
      'protected', 'side', 'status', 'turnover24h',
    ]);
  }
});

test('klines come from the venue that served the tickers (OKX when Bybit is blocked)', async () => {
  const calls = [];
  const impl = async (u) => {
    calls.push(String(u));
    if (String(u).includes('bybit.com')) throw new Error('blocked by country');
    if (String(u).includes('/market/tickers')) {
      return ok({ data: [{ instId: 'BTC-USDT-SWAP', open24h: '100', last: '104', volCcy24h: '2000000' }] });
    }
    return ok({ data: rows() });
  };
  const res = await withFetch(impl, () => handleCandidates(new URL('https://x.test/candidates?top100=BTC')));
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  assert.equal(b.items[0].status, 'in_zone');
  const klineCalls = calls.filter((u) => !u.includes('/market/tickers'));
  assert.equal(klineCalls.length, 1);
  assert.ok(klineCalls.every((u) => u.includes('okx.com')));
});

test('one coin failing its klines is listed as error; the rest still return', async () => {
  const v = venue({
    kline: (u) => (symbolOf(u) === 'ETHUSDT'
      ? new Response('upstream exploded', { status: 500 })
      : ok({ result: { list: rows() } })),
  });
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  const eth = b.items.find((x) => x.base === 'ETH');
  assert.equal(eth.status, 'error');
  assert.match(eth.detail, /500/);
  assert.equal(b.items.at(-1).base, 'ETH', 'errors sort last');
  assert.equal(v.calls.length, 1 + 3, 'no retries on the kline fan-out');
});

test('a geo-block across the whole fan-out stays inside the subrequest budget', async () => {
  const tickers = Array.from({ length: 25 }, (_, i) => bybitT(`C${String(i).padStart(2, '0')}`, 1e9 - i * 1e6, 1));
  const v = venue({ tickers, kline: () => new Response('blocked', { status: 403 }) });
  const res = await withFetch(v.impl, () => handleCandidates(new URL('https://x.test/candidates')));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.items.length, 20, 'capped at 20');
  assert.ok(b.items.every((x) => x.status === 'error'));
  assert.ok(!b.items.some((x) => ['C20', 'C21', 'C22', 'C23', 'C24'].includes(x.base)), 'top 20 by turnover');
  assert.equal(v.calls.length, 21);
  assert.ok(v.calls.length <= 50);
});

test('a venue answering with no bars for a coin is an error row, not a thrown route', async () => {
  const v = venue({ kline: () => ok({ result: { list: [] } }) });
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.ok(b.items.every((x) => x.status === 'error'));
});

test('without top100 the universe is unfiltered, and the response says so', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL('https://x.test/candidates?exclude=BTW')));
  const b = await res.json();
  assert.equal(b.universeFiltered, false);
  assert.ok(b.items.some((x) => x.base === 'XAU'));
  assert.ok(!b.items.some((x) => x.base === 'BTW'));
});

test('reports 502 naming both venues when neither serves tickers', async () => {
  const res = await withFetch(
    async (u) => { throw new Error(String(u).includes('bybit.com') ? 'bybit down' : 'okx down'); },
    () => handleCandidates(new URL(CAND)),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.match(b.detail, /bybit down/);
  assert.match(b.detail, /okx down/);
});

test('CORS headers are present', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
```

- [ ] **Step 2: Run and see them fail.**

Run: `cd worker && npm test`
Expected: `candidates-route.test.js` fails (`handleCandidates` is not exported).

- [ ] **Step 3: Create the pure helpers.** Create `worker/src/compute/candidates.js`:

```js
/**
 * /candidates universe and ordering — pure, so index.js stays routing-only.
 * Spec: docs/superpowers/specs/2026-10-09-candidates-screener-design.md §2.
 */
export const CANDIDATES = { floor: 100_000_000, cap: 20, swingWidth: 3, bars: 200 };

/**
 * @param {{base:string, turnover24h:number}[]} tickers
 * @param {{floor:number, cap:number}} opts
 * @param {Set<string>|null} capBases  top-100-by-market-cap allowlist; null = unfiltered.
 *   Load-bearing: a turnover floor alone admits non-crypto Bybit listings (XAU, CL, SOXL).
 * @param {Set<string>} exclude  the no-trade list
 */
export function selectUniverse(tickers, opts, capBases, exclude) {
  if (!Array.isArray(tickers)) return [];
  return tickers
    .filter((t) => t.turnover24h >= opts.floor)
    .filter((t) => !capBases || capBases.has(t.base))
    .filter((t) => !exclude.has(t.base))
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, opts.cap);
}

const RANK = { in_zone: 0, outside: 1, broken: 2, unclear: 3, error: 4 };

/**
 * in_zone, then outside, each closest to 50% first; then broken, unclear and
 * error by turnover. Failures are listed, never dropped, so a missing coin
 * always means "below the criterion".
 */
export function sortCandidates(items) {
  return [...items].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r) return r;
    if (a.status === 'in_zone' || a.status === 'outside') {
      return Math.abs(a.pctOfRange - 50) - Math.abs(b.pctOfRange - 50);
    }
    return b.turnover24h - a.turnover24h;
  });
}
```

- [ ] **Step 4: Add the route.** In `worker/src/index.js`, below `import { rankMovers, MOVERS } from './compute/movers.js';`, add:

```js
import { anchoredRange, ANCHORED } from './compute/anchored.js';
import { selectUniverse, sortCandidates, CANDIDATES } from './compute/candidates.js';
```

Directly below `handleMovers` (after its closing `}`), add:

```js
/**
 * Candidates pre-screen — 4H trend + pullback into the anchored range. See
 * compute/anchored.js and docs/superpowers/specs/2026-10-09-candidates-screener-design.md.
 *
 * Every kline comes from the venue that served the tickers, so the turnover
 * criterion and the structure are read off the same book. Klines go out with
 * retry:false: a geo-block mid-fan-out would otherwise multiply 20 requests by
 * the retry ladder and blow the 50-subrequest budget. A failed coin is an
 * `error` row, never a failed route.
 */
export async function handleCandidates(url) {
  const now = Date.now();
  const res = await withFallback(
    () => bybitTickers(fetcher(30)),
    () => okxTickers(fetcher(30)),
  );
  if (!res.ok) {
    return json({
      ts: now, error: 'No venue could serve market tickers',
      detail: res.err,
    }, 502);
  }
  const csv = (k) => new Set((url?.searchParams.get(k) ?? '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const top100 = csv('top100');
  const capBases = top100.size ? top100 : null;
  const exclude = csv('exclude');

  const { source, tickers } = res.val;
  const candles = source === 'OKX SWAP' ? okxCandles : bybitCandles;
  const j = fetcher(60);
  const once = (u, o = {}) => j(u, { ...o, retry: false });

  const items = await Promise.all(
    selectUniverse(tickers, CANDIDATES, capBases, exclude).map(async (t) => {
      const head = { base: t.base, turnover24h: t.turnover24h, last: t.last };
      try {
        const { bars } = await candles(resolvePair(t.base), now, CANDIDATES.bars, once);
        return { ...head, ...anchoredRange(bars, t.last, { ...ANCHORED, swingWidth: CANDIDATES.swingWidth }) };
      } catch (e) {
        return {
          ...head, side: null, protected: null, extreme: null, pctOfRange: null,
          distToProtectedPct: null, bosAgeBars: null, status: 'error', detail: e.message,
        };
      }
    }),
  );

  return json({
    ts: now, source,
    criterion: { turnoverFloor: CANDIDATES.floor, swingWidth: CANDIDATES.swingWidth },
    universeFiltered: capBases != null,
    excluded: [...exclude],
    items: sortCandidates(items),
  });
}
```

In the router, below `if (url.pathname === '/movers') return handleMovers(url);`, add:

```js
    if (url.pathname === '/candidates') return handleCandidates(url);
```

- [ ] **Step 5: Run all tests.**

Run: `cd worker && npm test`
Expected: all pass (227).

- [ ] **Step 6: Document the route.** In `CLAUDE.md`, replace

```
  ├─ GET /movers              ─▶ Worker ─▶ Bybit ALL tickers (1 call, OKX fallback)
  │       └─ awareness-only — rides the same Refresh press, never scored
```

with

```
  ├─ GET /movers              ─▶ Worker ─▶ Bybit ALL tickers (1 call, OKX fallback)
  │       └─ awareness-only — rides the same Refresh press, never scored
  ├─ GET /candidates          ─▶ Worker ─▶ tickers (1) + 4H klines per coin (≤ 20,
  │       │                      same venue as the tickers, no retries)
  │       └─ pre-screen: 4H trend + pullback into the anchored range, never scored
```

and replace

```
  compute/          klines · ema · fvg · equilibrium · sweep · mode · walls
                    · absorption  (§IV Step 2, /ltf only) · regime · movers
```

with

```
  compute/          klines · ema · fvg · equilibrium · sweep · mode · walls
                    · absorption  (§IV Step 2, /ltf only) · regime · movers
                    · anchored · candidates  (/candidates pre-screen — never scored)
```

- [ ] **Step 7: Commit.**

```bash
git add worker/src/compute/candidates.js worker/src/index.js worker/test/candidates-route.test.js CLAUDE.md
git commit -m "worker: GET /candidates — venue-consistent 4H anchored-range pre-screen"
```

---

### Task 4: The Candidates section on the Movers tab

**Files:**
- Create: `src/lists.js`
- Create: `src/candidates.js`
- Modify: `src/api.js` (append `fetchCandidates`, import `NO_TRADE`)
- Modify: `src/main.js` (imports; `load()` shares one top-100 promise)
- Modify: `index.html` (`#view-movers`)
- Modify: `styles.css` (after the Movers block)
- Modify: `CLAUDE.md` (`src/` module list)
- Create: `worker/test/candidates-ui.test.js`

**Interfaces:**
- Consumes: the `/candidates` JSON body from Task 3.
- Produces: `candidatesHtml(data, watchlist = WATCHLIST) → string` and `renderCandidates(data)`. Both treat `data === null` as a failed fetch.

- [ ] **Step 1: Write the failing tests.** Create `worker/test/candidates-ui.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesHtml } from '../../src/candidates.js';

const item = (o) => ({
  base: 'SOL', turnover24h: 584e6, last: 104, side: 'long', protected: 90,
  extreme: 120, pctOfRange: 46.7, distToProtectedPct: -13.5, bosAgeBars: 4,
  status: 'in_zone', ...o,
});
const body = (items, extra = {}) => ({ universeFiltered: true, items, ...extra });

test('a failed fetch says unavailable', () => {
  assert.match(candidatesHtml(null), /Candidates unavailable/);
});

test('an empty list says nothing cleared, rather than rendering blank', () => {
  assert.match(candidatesHtml(body([])), /Nothing cleared the criterion/);
});

test('a ranged row shows side, status, percent, protected point and BOS age', () => {
  const html = candidatesHtml(body([item()]));
  assert.match(html, /LONG/);
  assert.match(html, /in zone/);
  assert.match(html, /47%/);
  assert.match(html, /prot 90/);
  assert.match(html, /BOS 16h/);
  assert.match(html, /\$584M/);
});

test('off-list is marked for coins outside the watchlist only', () => {
  const html = candidatesHtml(body([item(), item({ base: 'ENA' })]), ['SOL']);
  assert.equal((html.match(/off-list/g) ?? []).length, 1);
  assert.match(html, /ENA[\s\S]*off-list/);
});

test('a broken row shows no percent and no protected point', () => {
  const html = candidatesHtml(body([item({ status: 'broken', pctOfRange: -3 })]));
  assert.match(html, /broken/);
  assert.doesNotMatch(html, /%<\/span>/);
  assert.doesNotMatch(html, /prot /);
});

test('upstream error text never reaches the markup', () => {
  const html = candidatesHtml(body([item({
    status: 'error', side: null, protected: null, pctOfRange: null,
    distToProtectedPct: null, bosAgeBars: null, detail: '<img src=x onerror=alert(1)>',
  })]));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /error/);
});

test('an unfiltered universe shows the warning banner', () => {
  assert.match(candidatesHtml(body([item()], { universeFiltered: false })), /unfiltered/);
  assert.doesNotMatch(candidatesHtml(body([item()])), /unfiltered/);
});

test('the frontend candidates module stays non-interactive and never renders grading fields', () => {
  const src = readFileSync(new URL('../../src/candidates.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick/i.test(src));
  assert.ok(!/score|verdict/i.test(src));
});
```

- [ ] **Step 2: Run and see them fail.**

Run: `cd worker && npm test`
Expected: `candidates-ui.test.js` fails to load (`Cannot find module '../../src/candidates.js'`). A Node `MODULE_TYPELESS_PACKAGE_JSON` warning about `src/` is expected once the module exists, and is harmless: Node detects ESM syntax.

- [ ] **Step 3: Create the lists.** Create `src/lists.js`:

```js
/**
 * Pair names only, mirrored from the trading playbook's §II (private vault),
 * which is the source of truth. Change them there first, then here.
 */
export const WATCHLIST = ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'HYPE'];
export const NO_TRADE = ['BTW'];
```

- [ ] **Step 4: Create the renderer.** Create `src/candidates.js`:

```js
import { fmtUsd, fmtPrice, fmtPct } from './format.js';
import { WATCHLIST } from './lists.js';

/**
 * Candidates pre-screen render. Rows are not clickable and nothing here grades
 * a setup — the chart read decides. `item.detail` is never put into the
 * markup: it can carry an exchange's raw response body.
 */
const LABEL = { in_zone: 'in zone', outside: 'outside', broken: 'broken', unclear: 'unclear', error: 'error' };

const age = (bars) => {
  const h = bars * 4;
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

export function candidatesHtml(data, watchlist = WATCHLIST) {
  if (!data || !Array.isArray(data.items)) {
    return '<p class="movers-empty">Candidates unavailable.</p>';
  }
  const banner = data.universeFiltered === false
    ? '<p class="cand-banner">⚠ unfiltered — may include non-crypto (XAU, CL)</p>'
    : '';
  if (!data.items.length) {
    return banner + '<p class="movers-empty">Nothing cleared the criterion right now.</p>';
  }
  const listed = new Set(watchlist);
  return banner + data.items.map((m) => {
    const ranged = m.status === 'in_zone' || m.status === 'outside';
    return `
    <div class="mover-row cand-row">
      <span class="mv-base">${m.base}</span>
      <span class="cand-side">${m.side ? m.side.toUpperCase() : '—'}</span>
      <span class="cand-status st-${m.status}">${LABEL[m.status] ?? 'unknown'}</span>
      ${ranged ? `<span class="cand-pct">${m.pctOfRange.toFixed(0)}%</span>` : ''}
      ${ranged ? `<span class="cand-prot">prot ${fmtPrice(m.protected)} (${fmtPct(m.distToProtectedPct, 1)})</span>` : ''}
      ${m.bosAgeBars != null ? `<span class="cand-bos">BOS ${age(m.bosAgeBars)}</span>` : ''}
      <span class="mv-vol">${fmtUsd(m.turnover24h)}</span>
      ${listed.has(m.base) ? '' : '<span class="cand-off">off-list</span>'}
    </div>`;
  }).join('');
}

export function renderCandidates(data) {
  document.getElementById('candidates-list').innerHTML = candidatesHtml(data);
}
```

- [ ] **Step 5: Run the UI tests.**

Run: `cd worker && npm test`
Expected: all pass (235).

- [ ] **Step 6: Add the API call.** In `src/api.js`, add `import { NO_TRADE } from './lists.js';` as the first line, and append at the end of the file:

```js
/**
 * Candidates pre-screen (4H trend + pullback into the anchored range). Same
 * ?top100= relay as fetchMovers; the no-trade list rides along as ?exclude=.
 */
export const fetchCandidates = (top100Bases = null) =>
  get('/candidates', { top100: top100Bases, exclude: NO_TRADE.join(',') });
```

- [ ] **Step 7: Wire it into `load()`.** In `src/main.js`, change the first import to:

```js
import { fetchMatrix, fetchAsset, fetchMacro, fetchMovers, fetchCandidates } from './api.js';
```

Below `import { renderMovers } from './movers.js';`, add:

```js
import { renderCandidates } from './candidates.js';
```

In `load()`, replace

```js
  fetchTop100Bases().catch(() => null)
    .then(fetchMovers)
    .then(renderMovers, () => renderMovers(null));
```

with

```js
  // One top-100 lookup feeds both lists. Candidates rides the same
  // fire-and-forget path: a slow /candidates must never delay Phase 1 either.
  const top100 = fetchTop100Bases().catch(() => null);
  top100.then(fetchMovers).then(renderMovers, () => renderMovers(null));
  top100.then(fetchCandidates).then(renderCandidates, () => renderCandidates(null));
```

- [ ] **Step 8: Markup.** In `index.html`, replace

```html
<section id="view-movers" hidden>
  <p class="movers-note">Awareness only — top 100 by market cap, ranked by move vs BTC. Not a score, not clickable, not a signal to trade any of these.</p>
```

with

```html
<section id="view-movers" hidden>
  <h3 class="cand-title">Candidates</h3>
  <p class="movers-note">4H trend + pullback into the anchored range — ≥ $100M turnover, top 100 by market cap. A pre-screen: the chart read decides. <b>off-list</b> = outside the current watchlist.</p>
  <div id="candidates-list" class="movers-list">
    <p class="movers-empty">Press Refresh to load.</p>
  </div>
  <h3 class="cand-title movers-gap">Movers</h3>
  <p class="movers-note">Awareness only — top 100 by market cap, ranked by move vs BTC. Not a score, not clickable, not a signal to trade any of these.</p>
```

- [ ] **Step 9: Styles.** In `styles.css`, directly after the line `.movers-empty{font-size:12px;color:var(--muted);padding:12px 0}`, add:

```css
/* Candidates — pre-screen above Movers. Same non-interactive row; wraps on a
   phone so no row forces horizontal scroll. */
.cand-title{font-family:'Space Grotesk',sans-serif;font-size:12px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--muted);margin:4px 0 6px}
.movers-gap{margin-top:18px}
.cand-row{flex-wrap:wrap;row-gap:4px}
.cand-side{width:44px;flex:none;font-size:11px;color:var(--muted)}
.cand-status{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--border);color:var(--muted)}
.cand-status.st-in_zone{border-color:var(--up);color:var(--up)}
.cand-status.st-broken{border-color:var(--down);color:var(--down)}
.cand-pct,.cand-prot,.cand-bos{font-variant-numeric:tabular-nums}
.cand-prot,.cand-bos{color:var(--muted)}
.cand-off{font-size:10px;padding:1px 6px;border-radius:6px;border:1px solid var(--warn);color:var(--warn)}
.cand-banner{font-size:11px;color:var(--warn);margin-bottom:6px}
```

- [ ] **Step 10: Document the modules.** In `CLAUDE.md`, replace

```
  movers.js         Movers tab render — awareness-only, no score, no click
```

with

```
  movers.js         Movers tab render — awareness-only, no score, no click
  candidates.js     Candidates section render (top of the Movers tab) — pre-screen, no click
  lists.js          WATCHLIST / NO_TRADE pair names, mirrored from the playbook's §II
```

- [ ] **Step 11: Run all tests.**

Run: `cd worker && npm test`
Expected: all pass (235).

- [ ] **Step 12: Commit.**

```bash
git add src/lists.js src/candidates.js src/api.js src/main.js index.html styles.css CLAUDE.md worker/test/candidates-ui.test.js
git commit -m "ui: Candidates section on the Movers tab — pre-screen above the awareness list"
```

---

### Task 5: Live check and ship

**Files:** none changed unless the live check finds a defect.

- [ ] **Step 1: Run the Worker locally against live venues.**

Run (background): `cd worker && npx wrangler dev --port 8787`
Then: `curl -s "http://localhost:8787/candidates?top100=BTC,ETH,SOL,XRP,DOGE,ADA,NEAR,SUI,HYPE,ENA,ONDO,ZEC&exclude=BTW" | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log(b.source,b.items.length);for(const i of b.items)console.log(i.base,i.side,i.status,i.pctOfRange?.toFixed(1),i.protected,i.extreme,i.detail??'')"`
Expected: a venue name, about 10–12 rows, real statuses, and no `error` rows unless a venue is actually blocked. If Bybit answers with the national-block address from this ISP, the source reads `OKX SWAP`, which is correct. Stop `wrangler dev` afterwards.

- [ ] **Step 2: Look at it in the page.** Open `index.html?api=http://localhost:8787` with `wrangler dev` running, switch to the Movers tab and press Refresh. Check the Candidates rows render above Movers and wrap cleanly at phone width (devtools, 390px). Then clear the override with `localStorage.removeItem('ppd_api')` in the console.

- [ ] **Step 3: Deploy the Worker. Ask the operator first.** This is outward-facing. The front end on GitHub Pages calls `/candidates`, so the Worker must ship **before** the front end is pushed, or the section reads "Candidates unavailable".

Run: `cd worker && npm run deploy`
Expected: wrangler prints the deployed URL. Then `curl -s "https://perp-pulse-data.perp-pulse-data.workers.dev/candidates?top100=BTC,ETH&exclude=BTW" | head -c 300` returns JSON with `items`.

- [ ] **Step 4: Push the front end.** `git push origin HEAD:main`. No PR is needed; this repo commits to main.
