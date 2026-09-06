# Movers Screener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an awareness-only "Movers" tab that scans the whole market (not just the watchlist) and lists coins moving unusually against BTC over the last 24h, so a real move like ARB or ASTER is visible even on a coin nobody pinned.

**Architecture:** One new Worker route (`GET /movers`) fetches ALL linear tickers from Bybit in a single call (OKX all-SWAP-tickers as fallback), ranks them by `|coin's 24h% − BTC's 24h%|` above a turnover floor, and returns the top 8. The frontend gets a second tab, rendered as plain inert rows — no score, no click-through, structurally excluded from every scoring engine by a permanent guard test.

**Tech Stack:** Cloudflare Workers (vanilla JS, `node --test` for the worker suite), static HTML/CSS/vanilla JS frontend (no build step, no frontend test runner).

**Spec:** [docs/superpowers/specs/2026-09-06-movers-screener-design.md](../specs/2026-09-06-movers-screener-design.md) — read it alongside this plan. It also carries the trading-vault history (R7 / Kevin Sailly) explaining *why* this is awareness-only; that constraint is not optional polish, it is the point of the feature.

## Global Constraints

- `MOVERS.floor = 10_000_000` (USD 24h turnover) and `MOVERS.top = 8` — provisional values from the spec, live in `compute/movers.js` only.
- Ranked by **absolute** relative strength vs BTC (`coin 24h% − BTC 24h%`), never raw `pct24h` alone and never raw volume alone.
- **Never referenced by `score.js`, `verdict.js`, `compute/absorption.js`, or `compute/regime.js`** — enforced by a permanent source-inspection test, not just a comment.
- **No click handlers, no score chips, no verdict** anywhere in the Movers tab. Rows are plain, inert text.
- `/movers` rides the existing manual Refresh press (`load()` in `main.js`). It is never on its own timer and a tab switch never fetches.
- A failed `/movers` fetch renders "Movers unavailable" inline inside the Movers tab. It must **never** trigger the page-wide `#err` banner — that stays reserved for the core matrix fetch.
- Follow the codebase's existing file organization: venue fetch functions live in that venue's own `sources/<venue>.js` file (not a combined `sources/movers.js` — the spec's file list is corrected here to match the actual established convention: `sources/bybit.js`, `sources/okx.js`, `sources/binance.js`, `sources/macro.js` are one file per venue, always).

---

## Task 1: Ranking logic — `compute/movers.js`

**Files:**
- Create: `worker/src/compute/movers.js`
- Test: `worker/test/movers.test.js`

**Interfaces:**
- Produces: `MOVERS = { floor: number, top: number }` (default export values: `floor: 10_000_000`, `top: 8`)
- Produces: `rankMovers(tickers, opts = MOVERS) => Array<{base, pct24h, turnover24h, rel}>` where input tickers are `Array<{base: string, pct24h: number, turnover24h: number}>`. Non-array input returns `[]`. BTC is excluded from the output but its `pct24h` is used as the baseline (defaults to `0` if absent). Output is sorted by `Math.abs(rel)` descending and sliced to `opts.top`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/movers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankMovers, MOVERS } from '../src/compute/movers.js';

const t = (base, pct24h, turnover24h) => ({ base, pct24h, turnover24h });

test('filters out anything below the turnover floor', () => {
  const tickers = [
    t('BTC', 1, 1_000_000_000),
    t('ARB', 20, 5_000_000),   // below the floor used in this test
    t('SOL', 15, 50_000_000),
  ];
  const out = rankMovers(tickers, { floor: 10_000_000, top: 8 });
  assert.equal(out.some((x) => x.base === 'ARB'), false);
  assert.equal(out.some((x) => x.base === 'SOL'), true);
});

test('excludes BTC from the output but uses its pct24h as the baseline', () => {
  const tickers = [t('BTC', 5, 1_000_000_000), t('ETH', 8, 50_000_000)];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out.some((x) => x.base === 'BTC'), false);
  assert.equal(out.find((x) => x.base === 'ETH').rel, 3); // 8 - 5
});

test('ranks by absolute relative strength, not raw pct24h', () => {
  const tickers = [
    t('BTC', 0, 1_000_000_000),
    t('A', 2, 50_000_000),     // rel = 2
    t('B', -9, 50_000_000),    // rel = -9, bigger magnitude
  ];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out[0].base, 'B');
  assert.equal(out[1].base, 'A');
});

test('slices to the configured top count', () => {
  const tickers = [
    t('BTC', 0, 1e9),
    ...Array.from({ length: 20 }, (_, i) => t(`C${i}`, i, 1e8)),
  ];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out.length, 8);
});

test('empty input returns an empty array, not a throw', () => {
  assert.deepEqual(rankMovers([], { floor: 0, top: 8 }), []);
});

test('all tickers below the floor returns an empty array', () => {
  const tickers = [t('BTC', 0, 1e9), t('ARB', 20, 1)];
  assert.deepEqual(rankMovers(tickers, { floor: 10_000_000, top: 8 }), []);
});

test('a non-array input returns an empty array rather than throwing', () => {
  assert.deepEqual(rankMovers(null, { floor: 0, top: 8 }), []);
  assert.deepEqual(rankMovers(undefined, { floor: 0, top: 8 }), []);
});

test('missing BTC in the input defaults the baseline to 0', () => {
  const tickers = [t('ETH', 4, 50_000_000)];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out[0].rel, 4); // 4 - 0
});

test('the exported MOVERS default matches the documented provisional values', () => {
  assert.equal(MOVERS.floor, 10_000_000);
  assert.equal(MOVERS.top, 8);
});

test('movers is never referenced by any of the four scoring engines', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(
      !/movers/i.test(src),
      `${p} references movers — it is awareness-only and must never enter scoring`,
    );
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd worker && node --test test/movers.test.js`
Expected: FAIL — `Cannot find module '../src/compute/movers.js'`

- [ ] **Step 3: Write the implementation**

Create `worker/src/compute/movers.js`:

```js
/**
 * Cross-market movers — "what actually moved unusually today, even on a coin
 * nobody is watching?" This sits OUTSIDE the four-question framework in
 * CLAUDE.md (score.js / verdict.js / absorption.js / regime.js): it is never
 * scored and never per-asset, closer to how dominance is display-only.
 *
 * Ranked by relative strength vs BTC because that is the actual screening
 * method this feature was requested to replicate (mentors/kevin-sailly.md in
 * the trading-vault, via playbook/pending-revisions.md R7's addendum) — but
 * this module is awareness-only by design. See
 * docs/superpowers/specs/2026-09-06-movers-screener-design.md for why: R7
 * already measured the small-cap relative-strength TRADING pattern at
 * -13.79R on this trader's own journal. The test file for this module
 * enforces, by source inspection, that it is never imported by score.js,
 * verdict.js, absorption.js or regime.js.
 */
export const MOVERS = {
  floor: 10_000_000, // USD 24h turnover — provisional, untuned against data
  top: 8,
};

/**
 * @param {{base:string, pct24h:number, turnover24h:number}[]} tickers
 * @param {{floor:number, top:number}} opts
 * @returns {{base:string, pct24h:number, turnover24h:number, rel:number}[]}
 */
export function rankMovers(tickers, opts = MOVERS) {
  if (!Array.isArray(tickers)) return [];
  const btcPct = tickers.find((x) => x.base === 'BTC')?.pct24h ?? 0;
  return tickers
    .filter((x) => x.base !== 'BTC' && x.turnover24h >= opts.floor)
    .map((x) => ({ ...x, rel: x.pct24h - btcPct }))
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel))
    .slice(0, opts.top);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd worker && node --test test/movers.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Run the full worker suite to confirm no regression**

Run: `cd worker && npm test`
Expected: PASS, all tests (107 pre-existing + 10 new = 117)

- [ ] **Step 6: Commit**

```bash
git add worker/src/compute/movers.js worker/test/movers.test.js
git commit -m "Add the movers ranking module, guarded out of scoring"
```

---

## Task 2: Venue fetchers + Worker route

**Files:**
- Modify: `worker/src/sources/bybit.js` (append a new export)
- Modify: `worker/src/sources/okx.js` (append a new export)
- Modify: `worker/src/index.js`
- Test: `worker/test/movers-route.test.js`

**Interfaces:**
- Consumes: `rankMovers`, `MOVERS` from `../compute/movers.js` (Task 1)
- Produces: `bybitTickers(j) => Promise<{source: 'Bybit linear', tickers: Array<{base, pct24h, turnover24h}>}>`
- Produces: `okxTickers(j) => Promise<{source: 'OKX SWAP', tickers: Array<{base, pct24h, turnover24h}>}>`
- Produces: `handleMovers()` (exported from `index.js`, no arguments) `=> Promise<Response>`. Success body: `{ts: number, source: string, items: Array<{base, pct24h, turnover24h, rel}>}`. Failure body (HTTP 502): `{ts: number, error: string, detail: string}`.

**Verified against live upstream responses (do not re-derive from memory — these two APIs have a real gotcha):**
- Bybit `GET /v5/market/tickers?category=linear` (no `symbol=`) returns **every** linear instrument (859 rows live, 751 ending in `USDT`) in one call. Relevant fields per row: `symbol` (e.g. `"BTCUSDT"`), `price24hPcnt` (fraction, e.g. `"0.004094"` = 0.41%), `turnover24h` (already USD notional, e.g. `"1403319108.88"`).
- OKX `GET /api/v5/market/tickers?instType=SWAP` returns every SWAP instrument (472 rows live). Relevant fields: `instId` (e.g. `"BTC-USDT-SWAP"`; coin-margined rows are `"-USD-SWAP"` and must be excluded), `open24h`, `last`, `volCcy24h`.
  **Gotcha confirmed live:** `volCcy24h` is in **base-coin units, not USD** — e.g. for ETH-USDT-SWAP, `vol24h` (contracts) / `volCcy24h` = exactly 10 (OKX's contract multiplier), and for SOL-USDT-SWAP the ratio is exactly 1. Using `volCcy24h` directly against a USD floor would silently misrank every symbol whose per-unit price isn't ~$1. **USD turnover is `volCcy24h * last`.**

- [ ] **Step 1: Write the failing tests**

Create `worker/test/movers-route.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMovers } from '../src/index.js';

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

/** Swaps global fetch for the duration of one test, then restores it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const bybitList = () => [
  { symbol: 'BTCUSDT', price24hPcnt: '0.01', turnover24h: '900000000' },
  { symbol: 'ARBUSDT', price24hPcnt: '0.22', turnover24h: '80000000' },
  { symbol: 'DUSTUSDT', price24hPcnt: '0.90', turnover24h: '10000' }, // below floor
  { symbol: 'BTCPERP', price24hPcnt: '0.01', turnover24h: '900000000' }, // not USDT-suffixed
];

const okxList = () => [
  { instId: 'BTC-USDT-SWAP', open24h: '79000', last: '79800', volCcy24h: '1000' },
  { instId: 'ASTER-USDT-SWAP', open24h: '0.60', last: '0.72', volCcy24h: '200000000' },
  { instId: 'BTC-USD-SWAP', open24h: '79000', last: '79800', volCcy24h: '1000' }, // coin-margined, excluded
];

test('returns ranked movers from Bybit', async () => {
  const res = await withFetch(
    async (u) => (String(u).includes('bybit.com')
      ? ok({ result: { list: bybitList() } })
      : (() => { throw new Error('OKX should not be called'); })()),
    () => handleMovers(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'Bybit linear');
  assert.equal(b.items.some((x) => x.base === 'BTC'), false); // baseline, excluded
  assert.equal(b.items.some((x) => x.base === 'DUST'), false); // below floor
  assert.ok(b.items.find((x) => x.base === 'ARB'));
  assert.equal(typeof b.ts, 'number');
});

test('falls back to OKX when Bybit is geo-blocked, converting volCcy24h to USD', async () => {
  const res = await withFetch(
    async (u) => {
      if (String(u).includes('bybit.com')) throw new Error('blocked by country');
      return ok({ data: okxList() });
    },
    () => handleMovers(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  // 200,000,000 volCcy * 0.72 last = $144,000,000 — clears the floor.
  assert.ok(b.items.find((x) => x.base === 'ASTER'));
  assert.equal(b.items.some((x) => x.base === 'BTC'), false);
});

test('reports 502 naming both venues when neither answers', async () => {
  const res = await withFetch(
    async (u) => { throw new Error(String(u).includes('bybit.com') ? 'bybit down' : 'okx down'); },
    () => handleMovers(),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.match(b.detail, /bybit down/);
  assert.match(b.detail, /okx down/);
});

test('CORS headers are present so the page can call it', async () => {
  const res = await withFetch(
    async () => ok({ result: { list: bybitList() } }),
    () => handleMovers(),
  );
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd worker && node --test test/movers-route.test.js`
Expected: FAIL — `handleMovers is not a function` (or similar export error)

- [ ] **Step 3: Add `bybitTickers` to `worker/src/sources/bybit.js`**

Append to the end of the file (after the existing `bybitDeep` function):

```js
/**
 * ALL linear USDT tickers in ONE call — for the /movers screener. Unlike
 * every other function in this file, this scans the whole market rather than
 * one symbol: Bybit's tickers endpoint returns every listed symbol's 24h
 * stats in a single response whether `symbol=` is given or not.
 */
export async function bybitTickers(j) {
  const r = await j(`${B}/v5/market/tickers?category=linear`);
  const list = r?.result?.list ?? [];
  const tickers = list
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => ({
      base: t.symbol.replace(/USDT$/, ''),
      pct24h: +t.price24hPcnt * 100,
      turnover24h: +t.turnover24h,
    }))
    .filter((t) => Number.isFinite(t.pct24h) && Number.isFinite(t.turnover24h));
  if (!tickers.length) throw new Error('Bybit returned no USDT linear tickers');
  return { source: 'Bybit linear', tickers };
}
```

- [ ] **Step 4: Add `okxTickers` to `worker/src/sources/okx.js`**

Append to the end of the file (after the existing `okxExtras` function):

```js
/**
 * ALL USDT-margined SWAP tickers in ONE call — /movers fallback when Bybit's
 * CDN geo-blocks this edge. Two things this endpoint does NOT give directly:
 *
 * 1. No 24h %-change field — derived from open24h/last, same arithmetic as
 *    okxCore() above.
 * 2. `volCcy24h` is in BASE-COIN units, not USD (confirmed against live data:
 *    for ETH-USDT-SWAP, vol24h(contracts) / volCcy24h = 10 exactly, OKX's own
 *    contract multiplier for that instrument). Multiplying by `last` gets USD
 *    notional, comparable to Bybit's turnover24h.
 */
export async function okxTickers(j) {
  const r = await j(`${O}/api/v5/market/tickers?instType=SWAP`);
  const list = r?.data ?? [];
  const tickers = list
    .filter((t) => t.instId.endsWith('-USDT-SWAP'))
    .map((t) => {
      const open = +t.open24h, last = +t.last, volCcy = +t.volCcy24h;
      return {
        base: t.instId.replace(/-USDT-SWAP$/, ''),
        pct24h: open ? (last / open - 1) * 100 : NaN,
        turnover24h: volCcy * last,
      };
    })
    .filter((t) => Number.isFinite(t.pct24h) && Number.isFinite(t.turnover24h));
  if (!tickers.length) throw new Error('OKX returned no USDT SWAP tickers');
  return { source: 'OKX SWAP', tickers };
}
```

- [ ] **Step 5: Wire the route into `worker/src/index.js`**

Modify the existing import lines (near the top of the file):

```js
import { bybitCore, bybitDeep, bybitLtf } from './sources/bybit.js';
import { okxExtras, okxCore, okxOpenInterest, okxLtf } from './sources/okx.js';
```

becomes:

```js
import { bybitCore, bybitDeep, bybitLtf, bybitTickers } from './sources/bybit.js';
import { okxExtras, okxCore, okxOpenInterest, okxLtf, okxTickers } from './sources/okx.js';
```

and add, alongside the other `compute/` imports:

```js
import { rankMovers, MOVERS } from './compute/movers.js';
```

Add a new handler, placed after `handleLtf` and before `export default`:

```js
/**
 * Cross-market movers, awareness-only — see compute/movers.js and CLAUDE.md.
 * One call regardless of universe size: Bybit's tickers endpoint returns
 * every symbol's 24h stats at once, unlike every other route here.
 */
export async function handleMovers() {
  const now = Date.now();
  let res = await attempt(() => bybitTickers(fetcher(30)));
  let bybitErr = null;
  if (!res.ok) {
    bybitErr = res.err;
    res = await attempt(() => okxTickers(fetcher(30)));
    if (!res.ok) {
      return json({
        ts: now, error: 'No venue could serve market tickers',
        detail: `bybit: ${bybitErr} | okx: ${res.err}`,
      }, 502);
    }
  }
  const { source, tickers } = res.val;
  return json({ ts: now, source, items: rankMovers(tickers, MOVERS) });
}
```

Modify the route dispatcher:

```js
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/macro') return handleMacro(url);
    if (url.pathname === '/ltf') return handleLtf(url);
    return handleAsset(url);
  },
};
```

becomes:

```js
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/macro') return handleMacro(url);
    if (url.pathname === '/ltf') return handleLtf(url);
    if (url.pathname === '/movers') return handleMovers();
    return handleAsset(url);
  },
};
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd worker && node --test test/movers-route.test.js`
Expected: PASS, 4 tests

- [ ] **Step 7: Run the full worker suite to confirm no regression**

Run: `cd worker && npm test`
Expected: PASS, all tests (117 from Task 1 + 4 new = 121)

- [ ] **Step 8: Manually sanity-check the route against real upstreams**

The unit tests mock `fetch`; this step proves the real Bybit/OKX responses parse correctly end to end. Run:

```bash
cd worker && npx wrangler dev --port 8787 &
sleep 3
curl -s http://127.0.0.1:8787/movers | python3 -m json.tool
kill %1
```

Expected: HTTP 200, `"source": "Bybit linear"`, and `items` is a non-empty array of `{base, pct24h, turnover24h, rel}` objects with plausible values (no `NaN`, no `BTC` in the list).

- [ ] **Step 9: Commit**

```bash
git add worker/src/sources/bybit.js worker/src/sources/okx.js worker/src/index.js worker/test/movers-route.test.js
git commit -m "Add the /movers Worker route (Bybit primary, OKX fallback)"
```

---

## Task 3: Frontend — Movers tab

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `src/api.js`
- Modify: `src/main.js`
- Create: `src/movers.js`

**Interfaces:**
- Consumes: `GET /movers` response shape from Task 2: `{ts, source, items: Array<{base, pct24h, turnover24h, rel}>}` on success; a rejected promise on failure (matching how `fetchMacro()`/`fetchDominance()` already behave through `api.js`'s shared `get()` helper, which throws on a non-2xx response or a body carrying `error`).
- Produces: `fetchMovers()` in `src/api.js`, same shape as `fetchMacro`/`fetchLtf`.
- Produces: `renderMovers(data)` in `src/movers.js` — `data` is either the parsed success body above, or `null` on failure. Writes into `#movers-list`. No return value.

There is no frontend test runner in this repo (no root `package.json`) — this task's verification is a manual browser check, per this project's own rule that UI changes must be checked in a real browser before being called done.

- [ ] **Step 1: Add the tab bar and Movers section to `index.html`**

Current structure (for reference):

```html
<div class="weather" id="weather">
  <div class="w-item"><span class="w-label">BTC.D</span><span class="w-val" id="w-btcd">—</span></div>
  <div class="w-item"><span class="w-label">USDT.D</span><span class="w-val" id="w-usdtd">—</span></div>
  <div class="w-item"><span class="w-label">TOTAL3</span><span class="w-val" id="w-total3">—</span></div>
</div>

<div class="wl-bar">
  <input id="wl-input" class="wl-input" type="text" inputmode="latin" autocapitalize="characters"
         autocomplete="off" spellcheck="false" maxlength="15"
         placeholder="Add a coin — e.g. PEPE" aria-label="Look up a coin by ticker">
  <button id="wl-reset" class="ghost" title="Restore the playbook §II watchlist">Reset</button>
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
```

Replace it with:

```html
<div class="weather" id="weather">
  <div class="w-item"><span class="w-label">BTC.D</span><span class="w-val" id="w-btcd">—</span></div>
  <div class="w-item"><span class="w-label">USDT.D</span><span class="w-val" id="w-usdtd">—</span></div>
  <div class="w-item"><span class="w-label">TOTAL3</span><span class="w-val" id="w-total3">—</span></div>
</div>

<nav class="tabs" role="tablist">
  <button id="tab-matrix" class="tab active" role="tab" aria-selected="true">Matrix</button>
  <button id="tab-movers" class="tab" role="tab" aria-selected="false">Movers</button>
</nav>

<div id="stale" class="stale" hidden></div>
<div id="err" hidden></div>

<div id="view-matrix">
  <div class="wl-bar">
    <input id="wl-input" class="wl-input" type="text" inputmode="latin" autocapitalize="characters"
           autocomplete="off" spellcheck="false" maxlength="15"
           placeholder="Add a coin — e.g. PEPE" aria-label="Look up a coin by ticker">
    <button id="wl-reset" class="ghost" title="Restore the playbook §II watchlist">Reset</button>
  </div>

  <main id="matrix" class="matrix"></main>

  <section id="detail" class="detail" hidden></section>

  <details class="legend">
    <summary>Sanity check legend</summary>
    <p><b>Normal pullback 🟢</b> — OI stable or rising (absorption) + funding neutral or negative.</p>
    <p><b>Aggressive dump 🔴</b> — heavy OI flush (cascade) + funding heavily positive + ETF outflows.</p>
  </details>
</div>

<section id="view-movers" hidden>
  <p class="movers-note">Awareness only — the whole market, ranked by move vs BTC. Not a score, not clickable, not a signal to trade any of these.</p>
  <div id="movers-list" class="movers-list">
    <p class="movers-empty">Press Refresh to load.</p>
  </div>
</section>
```

The `<script type="module" src="src/main.js"></script>` line and everything outside this block (header, footer) is unchanged.

- [ ] **Step 2: Add styles to `styles.css`**

Append to the end of the file:

```css
/* Tab switch between Matrix and Movers — pure visibility toggle, never fetches. */
.tabs{display:flex;gap:6px;margin-bottom:12px}
.tab{flex:1;background:var(--card);border:1px solid var(--border);color:var(--muted);
  font:inherit;font-size:12px;padding:8px;border-radius:8px;cursor:pointer}
.tab.active{color:var(--text);border-color:var(--steel)}

/* Movers — awareness only. Unlike .row, nothing here is clickable: no hover
   state, no cursor:pointer, no left-edge signal color. */
.movers-note{font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5}
.movers-list{display:flex;flex-direction:column;gap:6px}
.mover-row{display:flex;align-items:baseline;gap:10px;background:var(--card);
  border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:12px}
.mv-base{font-family:'Space Grotesk',sans-serif;font-weight:700;width:52px;flex:none}
.mv-pct{font-variant-numeric:tabular-nums;width:64px;flex:none}
.mv-rel{font-variant-numeric:tabular-nums;color:var(--muted)}
.mv-vol{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.movers-empty{font-size:12px;color:var(--muted);padding:12px 0}
```

- [ ] **Step 3: Add `fetchMovers` to `src/api.js`**

Add after the existing `fetchLtf` export:

```js
/**
 * Awareness-only cross-market screener. Rides the normal manual-refresh
 * cadence — no separate timer, unlike /ltf which is deliberately excluded
 * from every automatic path.
 */
export const fetchMovers = () => get('/movers', {});
```

- [ ] **Step 4: Create `src/movers.js`**

```js
import { fmtUsd, fmtPct, signClass } from './format.js';

/**
 * Awareness-only: no click handler, no score, no verdict. Plain rows so this
 * can never be mistaken for a Phase 1/2 read on an off-list coin. `data` is
 * null on a failed fetch — see main.js's load(), which catches the same way
 * it already does for fetchMacro/fetchDominance.
 */
export function renderMovers(data) {
  const el = document.getElementById('movers-list');
  if (!data) {
    el.innerHTML = '<p class="movers-empty">Movers unavailable.</p>';
    return;
  }
  if (!data.items.length) {
    el.innerHTML = '<p class="movers-empty">Nothing cleared the volume floor right now.</p>';
    return;
  }
  el.innerHTML = data.items.map((m) => `
    <div class="mover-row">
      <span class="mv-base">${m.base}</span>
      <span class="mv-pct ${signClass(m.pct24h)}">${fmtPct(m.pct24h, 1)}</span>
      <span class="mv-rel ${signClass(m.rel)}">${m.rel >= 0 ? '+' : ''}${m.rel.toFixed(1)}pp vs BTC</span>
      <span class="mv-vol">${fmtUsd(m.turnover24h)}</span>
    </div>`).join('');
}
```

- [ ] **Step 5: Wire it into `src/main.js`**

Modify the top import block:

```js
import { fetchMatrix, fetchAsset, fetchMacro } from './api.js';
import { renderRow, sortRows } from './matrix.js';
import { renderDetail } from './detail.js';
import { renderWeather, initEtfToggle, fetchDominance } from './weather.js';
import { enrichBinance } from './binance-enrich.js';
```

becomes:

```js
import { fetchMatrix, fetchAsset, fetchMacro, fetchMovers } from './api.js';
import { renderRow, sortRows } from './matrix.js';
import { renderDetail } from './detail.js';
import { renderWeather, initEtfToggle, fetchDominance } from './weather.js';
import { enrichBinance } from './binance-enrich.js';
import { renderMovers } from './movers.js';
```

Inside `load()`, modify:

```js
  const [macro, dom] = await Promise.all([
    fetchMacro().catch(() => null),
    fetchDominance().catch(() => null),
  ]);
  renderWeather(macro, dom);
```

becomes:

```js
  const [macro, dom, movers] = await Promise.all([
    fetchMacro().catch(() => null),
    fetchDominance().catch(() => null),
    fetchMovers().catch(() => null),
  ]);
  renderWeather(macro, dom);
  renderMovers(movers);
```

Add a tab-switching function and wire the two buttons. Place this near `closeDetail()`:

```js
function selectTab(name) {
  const isMatrix = name === 'matrix';
  $('view-matrix').hidden = !isMatrix;
  $('view-movers').hidden = isMatrix;
  $('tab-matrix').classList.toggle('active', isMatrix);
  $('tab-movers').classList.toggle('active', !isMatrix);
  $('tab-matrix').setAttribute('aria-selected', String(isMatrix));
  $('tab-movers').setAttribute('aria-selected', String(!isMatrix));
}
```

Add the listeners alongside the existing ones near the bottom of the file (next to `$('refresh').addEventListener(...)`):

```js
$('tab-matrix').addEventListener('click', () => selectTab('matrix'));
$('tab-movers').addEventListener('click', () => selectTab('movers'));
```

- [ ] **Step 6: Verify in the browser**

The Worker needs to be reachable. Start it locally:

```bash
cd worker && npx wrangler dev --port 8787
```

In a separate terminal, serve the static frontend (matching `.claude/launch.json`'s existing `dashboard` config, e.g. `python3 -m http.server 8788 --bind 127.0.0.1` from the repo root), then open it in the Browser pane at:

```
http://localhost:8788/?api=http://127.0.0.1:8787
```

Check, using the Browser pane tools (`read_page`/`get_page_text`, `computer` for clicks, `read_console_messages` for errors):

1. Page loads with the `Matrix` tab active and `Movers` tab present but inactive.
2. Click `Movers` — the matrix, watchlist input, and legend disappear; the movers note and (after pressing Refresh) a list of rows appear. No fetch fires from the click alone (check `read_network_requests` shows no new request from the tab click itself).
3. Press `Refresh` while on either tab — `read_network_requests` shows one `/movers` call. Switch tabs — no new request fires.
4. Movers rows show base symbol, signed 24h %, signed "pp vs BTC", and a volume figure. No row has a pointer cursor or click handler (`read_page` should show no `button`/clickable role on `.mover-row`).
5. With `wrangler dev` still running, stop it (Ctrl+C or kill the process) and press Refresh again. Expected: the core matrix still shows its last-good data (or its own stale/error handling, unrelated to movers), while `#movers-list` switches to "Movers unavailable" — and the page-wide `#err` banner does **not** appear. This is the live confirmation of the `fetchMovers().catch(() => null)` → `renderMovers(null)` path that Task 2's route-level 502 test already covers at the HTTP layer.
6. Resize to `mobile` preset (`resize_window`) and confirm the tab bar and mover rows don't overflow or truncate awkwardly.

Take a screenshot of the Movers tab with real data for the summary.

- [ ] **Step 7: Commit**

```bash
git add index.html styles.css src/api.js src/movers.js src/main.js
git commit -m "Add the Movers tab: awareness-only, no score, no click-through"
```

---

## Task 4: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/reading-the-dashboard.html`

- [ ] **Step 1: Update the architecture diagram in `CLAUDE.md`**

Find:

```
  ├─ GET /asset?symbol=X&deep=1 ─▶ Worker ─▶ + OKX + Binance + Bybit book (~14)
  │    └─ Binance fapi DIRECT from the device (hybrid client-side enrichment)
  └─ GET /ltf?symbol=X       ─▶ Worker ─▶ Bybit 15m klines (1 call, OKX fallback)
       └─ ON DEMAND ONLY — a button press, never the refresh loop
```

Replace with:

```
  ├─ GET /asset?symbol=X&deep=1 ─▶ Worker ─▶ + OKX + Binance + Bybit book (~14)
  │    └─ Binance fapi DIRECT from the device (hybrid client-side enrichment)
  ├─ GET /movers              ─▶ Worker ─▶ Bybit ALL tickers (1 call, OKX fallback)
  │       └─ awareness-only — rides the same Refresh press, never scored
  └─ GET /ltf?symbol=X       ─▶ Worker ─▶ Bybit 15m klines (1 call, OKX fallback)
       └─ ON DEMAND ONLY — a button press, never the refresh loop
```

- [ ] **Step 2: Update the Layout section**

Find:

```
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
                    · absorption  (§IV Step 2, /ltf only) · regime
  score.js          §VII bias engine        ─┐ four separate questions,
  verdict.js        Phase 2 pullback health  │ NEVER summed or averaged
  compute/absorption.js  §IV Step 2 LTF read ─┘
worker/test/        node --test suites (107 tests)
```

Replace with (test count updated to whatever `cd worker && npm test` actually reports after Tasks 1–2 — 121 if nothing else changed):

```
src/
  main.js           boot, manual refresh (opt-in timer), staleness, watchlist, tabs
  api.js            Worker client: fan-out, 8s timeout, per-asset failure
  matrix.js         Phase 1 grid + score chips
  detail.js         Phase 2 panel
  weather.js        BTC.D / USDT.D / TOTAL3 + manual ETF toggle
  movers.js         Movers tab render — awareness-only, no score, no click
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
worker/test/        node --test suites (121 tests)
```

**Before writing this edit, run `cd worker && npm test` and read the final `# tests N` line — use the real number, not 121 if it differs.**

- [ ] **Step 3: Add a note after the "Four questions, one codebase" section**

Find the paragraph ending:

```
`compute/regime.js` is the **fourth** question: *is the tape behaving abnormally
right now?* It is rendered on its own and never enters the other three — §VII
assigns no volatility row, and `worker/test/regime.test.js` asserts by source
inspection that `score.js`, `verdict.js` and `absorption.js` never mention it.
```

Add immediately after it:

```

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
```

- [ ] **Step 4: Add a Known-limits bullet**

Add to the "Known limits and quirks" list (anywhere after the existing regime bullets is fine):

```
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
```

- [ ] **Step 5: Add a section to `docs/reading-the-dashboard.html`**

Insert a new `<section>` immediately after the existing "The top strip" section (which ends with the ETF button paragraph, right before `<section>` / `<div class="sec-head"><div class="eyebrow">Screen order &#183; 2</div><h2>Reading one row</h2>`):

```html
<section>
  <div class="sec-head">
    <div class="eyebrow">Screen order &#183; 1b</div>
    <h2>The Movers tab</h2>
  </div>
  <p>A second tab beside the main grid. It scans the <strong>whole market</strong>, not just the watchlist, and lists coins moving unusually against Bitcoin over the last 24 hours &#8212; a way to notice a sudden alt rally before anyone mentions it.</p>
  <p>It is <strong>context only, the same as the top strip</strong> &#8212; nothing in this tab is clickable, scored, or feeds the grid's verdicts. It answers "what's moving?", not "should I trade this?". That second question still goes through the normal watchlist and its own confluence check.</p>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Reading</th><th>Plain meaning</th></tr></thead>
      <tbody>
        <tr><td class="num">24h %</td><td>The coin's own price change over the last 24 hours</td></tr>
        <tr><td class="num">vs BTC</td><td>That change minus Bitcoin's own 24h change &#8212; how much it is outpacing (or lagging) the market's anchor, in percentage points</td></tr>
        <tr><td class="num">24h volume</td><td>Dollar value traded in the last 24 hours, so a real move can be told apart from a thinly-traded coin drifting on no volume</td></tr>
      </tbody>
    </table>
  </div>
  <p>Only coins clearing a minimum volume floor appear, so illiquid noise cannot dominate the list. The floor is a first guess and may be retuned over time.</p>
</section>
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/reading-the-dashboard.html
git commit -m "Document the Movers tab: architecture, layout, and its awareness-only boundary"
```

---

## After all tasks: deployment

The Worker changes are only live in production after `cd worker && npx wrangler deploy` — this plan deliberately does not run it automatically. Confirm with the user before deploying, the same way any other change to this Worker would be confirmed.
