import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findSwings, findLiquidity } from '../src/compute/liquidity.js';

const H4 = 4 * 60 * 60 * 1000;

/** Bars from [high, low] pairs; open/close sit mid-range because none of this
 *  layer reads candle colour — only wicks take liquidity (§IV Step 1). */
const series = (hl, startT = 0) =>
  hl.map(([h, l], i) => ({ t: startT + i * H4, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 }));

const pick = (pools, tier, side) => pools.filter((p) => p.tier === tier && p.side === side);

test('findSwings locates 2-bar fractal highs and lows in bars-space indices', () => {
  const bars = series([[100, 99], [101, 100], [105, 104], [101, 100], [100, 99], [100, 99], [100, 99]]);
  const { highs, lows } = findSwings(bars);
  assert.deepEqual(highs, [{ i: 2, p: 105 }]);
  assert.deepEqual(lows, []);
});

const CLUSTER = [
  [100, 99], [101, 100], [105, 104], [101, 100], [100, 99],
  [101, 100], [105.05, 104.05], [101, 100], [100, 99],
];

test('two fractal highs inside tolerance collapse into one EQH cluster', () => {
  const { pools } = findLiquidity(series(CLUSTER), 100);
  const eqh = pick(pools, 'CLUSTER', 'high');
  assert.equal(eqh.length, 1);
  assert.equal(eqh[0].touches, 2);
  assert.deepEqual([eqh[0].bottom, eqh[0].top], [105, 105.05]);
  assert.equal(eqh[0].level, 105.05); // a high pool ticks at the top of its band
});

test('the lone fractal low in the same series stays tier FRACTAL', () => {
  const { pools } = findLiquidity(series(CLUSTER), 100);
  const lows = pick(pools, 'FRACTAL', 'low');
  assert.equal(lows.length, 1);
  assert.equal(lows[0].touches, 1);
  assert.equal(lows[0].level, 99);
});

test('two fractal highs outside tolerance stay two separate pools', () => {
  // 105 -> 108 is ~2.9%, far outside the 0.15% default.
  const hl = CLUSTER.map((r, i) => (i === 6 ? [108, 107] : r));
  const { pools } = findLiquidity(series(hl), 100);
  assert.equal(pick(pools, 'CLUSTER', 'high').length, 0);
  assert.equal(pick(pools, 'FRACTAL', 'high').length, 2);
});

test('a cluster is swept only once a wick clears the WHOLE band', () => {
  const partial = findLiquidity(series([...CLUSTER, [105.02, 104]]), 105);
  assert.equal(pick(partial.pools, 'CLUSTER', 'high')[0].swept, false,
    'a wick into the band took some stops, not the pool');

  const full = findLiquidity(series([...CLUSTER, [106, 104]]), 105);
  assert.equal(pick(full.pools, 'CLUSTER', 'high')[0].swept, true);
});

test('a low pool is swept by a wick BELOW it, not a body close', () => {
  const hl = [...CLUSTER, [100, 98.5]]; // wicks under the 99 fractal low, closes above
  const { pools } = findLiquidity(series(hl), 100);
  assert.equal(pick(pools, 'FRACTAL', 'low')[0].swept, true);
});

test('distance carries an absolute magnitude and a signed offset', () => {
  const { pools } = findLiquidity(series(CLUSTER), 100);
  const eqh = pick(pools, 'CLUSTER', 'high')[0];
  assert.equal(Math.round(eqh.distPct * 100) / 100, 5.05);
  assert.equal(Math.round(eqh.offsetPct * 100) / 100, 5.05); // above price -> positive
  const low = pick(pools, 'FRACTAL', 'low')[0];
  assert.equal(Math.round(low.offsetPct * 100) / 100, -1); // below price -> negative
});

/**
 * Regression: findLiquidity used to inherit equilibrium()/marketMode()'s
 * 30-bar window, so a pool older than 5 days was invisible even though
 * chart.js deliberately fetches 90 bars precisely so the zone layers can see
 * further back. Resting liquidity does not expire on a rolling window -- it
 * rests until it is taken.
 */
test('scans everything it is handed, not a rolling 30-bar window', () => {
  const quiet = Array.from({ length: 40 }, () => [101, 99]);
  const bars = series([...CLUSTER, ...quiet]); // the EQH pair is now ~40 bars back
  const { pools } = findLiquidity(bars, 100);
  const eqh = pick(pools, 'CLUSTER', 'high');
  assert.equal(eqh.length, 1, 'an unswept cluster 40 bars back is still resting liquidity');
  assert.equal(eqh[0].touches, 2);
  assert.equal(eqh[0].swept, false);
});

test('an explicit lookback still narrows the scan', () => {
  const quiet = Array.from({ length: 40 }, () => [101, 99]);
  const bars = series([...CLUSTER, ...quiet]);
  assert.equal(pick(findLiquidity(bars, 100, { lookback: 30 }).pools, 'CLUSTER', 'high').length, 0);
});

test('pools come back sorted nearest-first so the caller can just slice', () => {
  const { pools } = findLiquidity(series(CLUSTER), 100);
  const d = pools.map((p) => p.distPct);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
});

/**
 * The UTC+8 trap. OKX's own daily candles roll at 16:00 UTC, which is what
 * commit 97e845a had to fix. Aggregating the 4H bars into UTC days sidesteps
 * it -- so the 20:00 UTC bar MUST still count as the previous UTC day.
 */
test('PDH/PDL aggregate by UTC day, not by OKX daily candles UTC+8 roll', () => {
  const day0 = [
    [101, 99], [101, 99], [101, 99], [101, 99], [101, 99], // 00,04,08,12,16 UTC
    [200, 99], //                                             20:00 UTC -- UTC+8 calls this day 1
  ];
  const day1 = [[105, 95], [105, 95], [105, 95]]; // 00,04,08 UTC -- the forming day
  const { pools } = findLiquidity(series([...day0, ...day1]), 100);
  const pdh = pools.find((p) => p.tier === 'PD' && p.side === 'high');
  const pdl = pools.find((p) => p.tier === 'PD' && p.side === 'low');
  assert.equal(pdh.level, 200, 'the 20:00 UTC bar belongs to the previous UTC day');
  assert.equal(pdl.level, 99);
});

test('PD pool label comes from sweepState, not a second reclaim rule', () => {
  const day0 = [[101, 99], [101, 99], [101, 99], [101, 99], [101, 99], [101, 99]];
  const day1 = [[101, 90], [101, 95], [101, 95]]; // wicked under PDL 99, now back above
  const { pools } = findLiquidity(series([...day0, ...day1]), 100);
  const pdl = pools.find((p) => p.tier === 'PD' && p.side === 'low');
  assert.equal(pdl.label, 'PDL swept + reclaimed');
  assert.equal(pdl.swept, true);
});

test('no previous UTC day in the window means no PD pools, not a guess', () => {
  const { pools } = findLiquidity(series([[101, 99], [101, 99], [101, 99], [101, 99], [101, 99]]), 100);
  assert.equal(pools.filter((p) => p.tier === 'PD').length, 0);
});

test('too few bars returns empty rather than throwing', () => {
  assert.deepEqual(findLiquidity(series([[101, 99], [101, 99]]), 100).pools, []);
  assert.deepEqual(findSwings(series([])), { highs: [], lows: [] });
});

/**
 * The guard matches this module's IDENTIFIERS and import path, not the English
 * word: score.js:76 legitimately reads "Layer 5 — Liquidity sweep", because
 * §VII layer 5 really is a liquidity-sweep layer (via sweep.js). The question
 * this test asks is whether a scoring engine CONSUMES this module.
 */
const CONSUMES = /findLiquidity|findSwings|liquidity\.js|compute\/liquidity/i;

test('liquidity pools are never referenced by any scoring engine', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
    '../src/compute/movers.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(
      !CONSUMES.test(src),
      `${p} consumes liquidity pools — they are a display-only overlay, never a scored layer`,
    );
  }
});

test('the Worker never ships liquidity pools in the /asset payload', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(!CONSUMES.test(src), 'worker/src/index.js must not import liquidity');
});
