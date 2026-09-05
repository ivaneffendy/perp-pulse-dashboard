import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKlines, INTERVAL_4H, INTERVAL_1H,
  lastClosedBarChangePct, dailyFromHourly,
} from '../src/compute/klines.js';

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

test('lastClosedBarChangePct reads the last bar\'s own open->close return', () => {
  const bars = [{ t: 0, o: 100, h: 101, l: 99, c: 100 }, { t: H, o: 4, h: 10, l: 4, c: 5 }];
  assert.equal(lastClosedBarChangePct(bars), 25);
});

test('lastClosedBarChangePct is null with no bars or an unusable open', () => {
  assert.equal(lastClosedBarChangePct([]), null);
  assert.equal(lastClosedBarChangePct(undefined), null);
  assert.equal(lastClosedBarChangePct([{ t: 0, o: 0, h: 1, l: 0, c: 1 }]), null);
});

test('dailyFromHourly aggregates hourly bars into UTC-calendar-day highs and lows', () => {
  const D = INTERVAL_1H * 24;
  const bars = [
    { t: 0 * H, o: 100, h: 104, l: 99, c: 103 },       // day 0
    { t: 1 * H, o: 103, h: 110, l: 101, c: 105 },      // day 0 — sets the day's high
    { t: D + 0 * H, o: 105, h: 107, l: 104, c: 106 },  // day 1 (today)
    { t: D + 1 * H, o: 106, h: 109, l: 103, c: 108 },  // day 1, still forming
  ];
  const { today, prevDay } = dailyFromHourly(bars);
  assert.deepEqual(today, { t: D, o: 105, h: 109, l: 103, c: 108 });
  assert.deepEqual(prevDay, { t: 0, o: 100, h: 110, l: 99, c: 105 });
});

test('dailyFromHourly counts a still-forming hour toward today\'s extremes', () => {
  // This is the whole reason the caller must pass dropUnclosed=false bars: a
  // forming hour's high can already be today's most extreme print, and the
  // liquidity-sweep check reads today's high/low as it stands right now.
  const D = INTERVAL_1H * 24;
  const bars = [
    { t: D, o: 100, h: 101, l: 99, c: 100 },
    { t: D + H, o: 100, h: 150, l: 100, c: 149 }, // forming bar spikes above yesterday-style noise
  ];
  const { today } = dailyFromHourly(bars);
  assert.equal(today.h, 150);
});

test('dailyFromHourly returns nulls for insufficient input', () => {
  assert.deepEqual(dailyFromHourly([]), { today: null, prevDay: null });
  assert.deepEqual(dailyFromHourly(null), { today: null, prevDay: null });
  const { today, prevDay } = dailyFromHourly([{ t: 0, o: 1, h: 2, l: 0, c: 1 }]);
  assert.ok(today);
  assert.equal(prevDay, null);
});
