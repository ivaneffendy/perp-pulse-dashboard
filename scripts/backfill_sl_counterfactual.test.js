/**
 * Offline checks for the R11b counterfactual. The race() resolution is the part
 * worth pinning: it decides whether a buffer looks like it works.
 *
 * All figures here are invented. This repo is public; the journal is not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { race, touched } from './backfill_sl_counterfactual.js';

const bar = (t, h, l) => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2 });

test('a long stopped before reaching the widened target reads stopped', () => {
  const bars = [bar(0, 101, 99), bar(1, 102, 94), bar(2, 130, 120)];
  const got = race(bars, { isLong: true, stop: 95, target: 110 });
  assert.equal(got.outcome, 'stopped');
  assert.equal(got.at, 1);
});

test('a long that survives the sweep and then runs reads tp1', () => {
  // The §IV Step 6 case: the original stop would have been hit at 96, the
  // widened one at 94 is not, and the trade then pays.
  const bars = [bar(0, 101, 99), bar(1, 102, 95), bar(2, 112, 104)];
  const got = race(bars, { isLong: true, stop: 94, target: 110 });
  assert.equal(got.outcome, 'tp1');
  assert.equal(got.at, 2);
});

test('a bar touching BOTH levels counts as stopped', () => {
  // OHLC cannot order the high and the low inside one bar. Resolving the tie
  // against the buffer keeps the test from flattering the thing it is judging.
  const bars = [bar(0, 115, 90)];
  assert.equal(race(bars, { isLong: true, stop: 95, target: 110 }).outcome, 'stopped');
});

test('shorts mirror: stop is above, target below', () => {
  const bars = [bar(0, 101, 99), bar(1, 106, 98), bar(2, 99, 88)];
  assert.equal(race(bars, { isLong: false, stop: 105, target: 90 }).outcome, 'stopped');
  assert.equal(race(bars, { isLong: false, stop: 108, target: 90 }).outcome, 'tp1');
});

test('neither level reached inside the horizon stays undecided', () => {
  const bars = [bar(0, 101, 99), bar(1, 102, 98)];
  assert.equal(race(bars, { isLong: true, stop: 90, target: 130 }).outcome, 'open_at_horizon');
});

test('touched() ignores ordering — it only asks whether the level was reached', () => {
  const bars = [bar(0, 101, 99), bar(1, 140, 98)];
  assert.equal(touched(bars, { isLong: true, price: 130 }), true);
  assert.equal(touched(bars, { isLong: true, price: 150 }), false);
  assert.equal(touched(bars, { isLong: false, price: 98 }), true);
});
