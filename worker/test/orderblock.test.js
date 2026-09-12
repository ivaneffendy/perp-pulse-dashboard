import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findOrderBlocks, nearestUnmitigatedOb } from '../src/compute/orderblock.js';

const bar = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });
const flat = (n, price = 100) => Array.from({ length: n }, () => bar(price, price + 1, price - 1, price));

test('marks the last bearish candle before an up-impulse as a bullish order block', () => {
  const bars = [
    ...flat(10),
    bar(100, 101, 95, 96), // bearish candle right before the impulse
    bar(96, 110, 96, 108), // closes above the 10-bar baseline high (101) -> up impulse
  ];
  const obs = findOrderBlocks(bars);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, 'bull');
  assert.deepEqual([obs[0].bottom, obs[0].top], [95, 101]);
});

test('marks the last bullish candle before a down-impulse as a bearish order block', () => {
  const bars = [
    ...flat(10),
    bar(100, 105, 99, 104), // bullish candle right before the impulse
    bar(104, 104, 90, 91), // closes below the baseline low (99) -> down impulse
  ];
  const obs = findOrderBlocks(bars);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, 'bear');
  assert.deepEqual([obs[0].bottom, obs[0].top], [99, 105]);
});

test('no impulse, no order block', () => {
  assert.deepEqual(findOrderBlocks(flat(15)), []);
});

test('marks a block mitigated once price trades back through its midpoint', () => {
  const bars = [
    ...flat(10),
    bar(100, 101, 95, 96),
    bar(96, 110, 96, 108),
    bar(108, 108, 97, 98), // wicks back to 97, through the 98 midpoint of [95,101]
  ];
  assert.equal(findOrderBlocks(bars)[0].mitigated, true);
});

test('returns the nearest unmitigated block with a distance', () => {
  const bars = [
    ...flat(10),
    bar(100, 101, 95, 96),
    bar(99, 110, 99, 108), // low stays above the OB's own midpoint (98) so it isn't self-mitigated
  ];
  const near = nearestUnmitigatedOb(bars, 108);
  assert.equal(near.type, 'bull');
  assert.equal(Math.round(near.distPct * 100) / 100, 6.48); // 108 -> 101 is ~6.48% away
});

test('returns null when nothing is unmitigated', () => {
  assert.equal(nearestUnmitigatedOb(flat(15), 100), null);
});

test('a run of consecutive impulses reports its shared origin block ONCE', () => {
  // Without dedupe each impulse re-emits the same zone, and chart.js stacks
  // the translucent fills into a darker box and redraws the label on itself.
  const bars = [
    ...flat(10),
    bar(100, 101, 95, 96),      // the only bearish candle — the OB
    bar(96, 112, 95.9, 110),    // impulse 1
    bar(110, 126, 109.9, 124),  // impulse 2
    bar(124, 140, 123.9, 138),  // impulse 3
  ];
  const obs = findOrderBlocks(bars);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].index, 10);
  // The FIRST impulse is the displacement that created the zone.
  assert.equal(obs[0].impulseIndex, 11);
});

test('order blocks are never referenced by any scoring engine', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
    '../src/compute/movers.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(
      !/orderblock|order_block|orderBlock/i.test(src),
      `${p} references order blocks — they are a provisional display-only POI overlay`,
    );
  }
});

test('the Worker never ships order blocks in the /asset payload', () => {
  // OB is chart-only: it is imported by src/chart.js in the browser, never by
  // the Worker, so it cannot silently grow into a scored signal via signals.*.
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(!/orderblock/i.test(src), 'worker/src/index.js must not import order blocks');
});
