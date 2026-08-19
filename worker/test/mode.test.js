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
