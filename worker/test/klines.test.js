import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKlines, dailyFromHourly, INTERVAL_4H } from '../src/compute/klines.js';

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

// dailyFromHourly rebuilds UTC calendar-day bars from already-normalized,
// oldest-first hourly bars (OKX's native bar=1D buckets at UTC+8 midnight,
// not UTC — see CLAUDE.md — so its daily PDH/PDL is derived from the
// UTC-aligned hourly series it already fetches instead of that endpoint).
const D = 24 * H;
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });

test('groups hourly bars into UTC calendar-day buckets', () => {
  const hourly = [
    bar(0, 10, 12, 9, 11, 100),
    bar(1 * H, 11, 15, 10, 14, 200),
    bar(2 * H, 14, 14, 8, 9, 150),
    bar(1 * D, 9, 20, 9, 18, 300),
    bar(1 * D + 1 * H, 18, 19, 17, 17.5, 50),
  ];
  const days = dailyFromHourly(hourly);
  assert.deepEqual(days.map((d) => d.t), [0, 1 * D]);
});

test('takes open from the day\'s first hour and close from its last', () => {
  const hourly = [
    bar(0, 10, 12, 9, 11, 100),
    bar(1 * H, 11, 15, 10, 14, 200),
    bar(2 * H, 14, 14, 8, 9, 150),
    bar(1 * D, 9, 20, 9, 18, 300),
    bar(1 * D + 1 * H, 18, 19, 17, 17.5, 50),
  ];
  const [day0, day1] = dailyFromHourly(hourly);
  assert.deepEqual([day0.o, day0.c], [10, 9]);
  assert.deepEqual([day1.o, day1.c], [9, 17.5]);
});

test('takes high as the max and low as the min across the day\'s hours', () => {
  const hourly = [
    bar(0, 10, 12, 9, 11, 100),
    bar(1 * H, 11, 15, 10, 14, 200),
    bar(2 * H, 14, 14, 8, 9, 150),
    bar(1 * D, 9, 20, 9, 18, 300),
    bar(1 * D + 1 * H, 18, 19, 17, 17.5, 50),
  ];
  const [day0, day1] = dailyFromHourly(hourly);
  assert.deepEqual([day0.h, day0.l], [15, 8]);
  assert.deepEqual([day1.h, day1.l], [20, 9]);
});

test('sums volume across the day\'s hours', () => {
  const hourly = [
    bar(0, 10, 12, 9, 11, 100),
    bar(1 * H, 11, 15, 10, 14, 200),
    bar(2 * H, 14, 14, 8, 9, 150),
    bar(1 * D, 9, 20, 9, 18, 300),
    bar(1 * D + 1 * H, 18, 19, 17, 17.5, 50),
  ];
  const [day0, day1] = dailyFromHourly(hourly);
  assert.deepEqual([day0.v, day1.v], [450, 350]);
});

test('a lone hour becomes its own still-forming day bucket', () => {
  const days = dailyFromHourly([bar(1 * D, 5, 6, 4, 5, 10)]);
  assert.deepEqual(days, [{ t: 1 * D, o: 5, h: 6, l: 4, c: 5, v: 10 }]);
});

test('returns an empty array for no hourly bars', () => {
  assert.deepEqual(dailyFromHourly([]), []);
});
