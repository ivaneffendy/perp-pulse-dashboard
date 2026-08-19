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
