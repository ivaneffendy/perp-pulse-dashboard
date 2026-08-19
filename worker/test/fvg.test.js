import test from 'node:test';
import assert from 'node:assert/strict';
import { findFvgs, nearestUnmitigatedFvg } from '../src/compute/fvg.js';

const b = (l, h) => ({ t: 0, o: l, h, l, c: h, v: 1 });

test('REGRESSION: a gap UP is labelled bullish, not bearish', () => {
  // bar0 high 10  <  bar2 low 20  -> price gapped up -> BULLISH
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].type, 'bull');
  assert.deepEqual([gaps[0].bottom, gaps[0].top], [10, 20]);
});

test('REGRESSION: a gap DOWN is labelled bearish, not bullish', () => {
  // bar0 low 20  >  bar2 high 10 -> price gapped down -> BEARISH
  const gaps = findFvgs([b(20, 25), b(12, 18), b(5, 10)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].type, 'bear');
  assert.deepEqual([gaps[0].bottom, gaps[0].top], [10, 20]);
});

test('finds no gap when candle 1 and candle 3 overlap', () => {
  assert.deepEqual(findFvgs([b(5, 15), b(8, 18), b(10, 20)]), []);
});

test('marks a gap mitigated once price trades back through its midpoint', () => {
  // bull gap 10..20 (mid 15); a later bar wicks to 14 -> mitigated
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25), b(14, 30)]);
  assert.equal(gaps[0].mitigated, true);
});

test('leaves a gap unmitigated when price stays clear of the midpoint', () => {
  const gaps = findFvgs([b(5, 10), b(12, 18), b(20, 25), b(16, 30)]);
  assert.equal(gaps[0].mitigated, false);
});

test('returns the nearest unmitigated gap with a distance', () => {
  // 4th bar must NOT form a second gap, and must stay clear of mid (15).
  const bars = [b(5, 10), b(12, 18), b(20, 25), b(17, 30)];
  const near = nearestUnmitigatedFvg(bars, 25);
  assert.equal(near.type, 'bull');
  assert.equal(Math.round(near.distPct * 100) / 100, 20); // 25 -> 20 is 20% away
});

test('returns null when nothing is unmitigated', () => {
  assert.equal(nearestUnmitigatedFvg([b(5, 15), b(8, 18), b(10, 20)], 12), null);
});
