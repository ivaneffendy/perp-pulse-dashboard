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
