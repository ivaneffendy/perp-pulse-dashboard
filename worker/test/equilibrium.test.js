import test from 'node:test';
import assert from 'node:assert/strict';
import { equilibrium } from '../src/compute/equilibrium.js';

// Range 100..200 over 4 bars -> EQ = 150.
const bars = [
  { t: 0, o: 0, h: 200, l: 150, c: 0, v: 0 },
  { t: 1, o: 0, h: 180, l: 100, c: 0, v: 0 },
  { t: 2, o: 0, h: 170, l: 120, c: 0, v: 0 },
  { t: 3, o: 0, h: 160, l: 130, c: 0, v: 0 },
];

test('computes the midpoint of the swing range', () => {
  const e = equilibrium(bars, 140);
  assert.equal(e.hh, 200);
  assert.equal(e.ll, 100);
  assert.equal(e.eq, 150);
});

test('labels price below the midpoint as DISCOUNT', () => {
  assert.equal(equilibrium(bars, 140).zone, 'DISCOUNT');
});

test('labels price above the midpoint as PREMIUM', () => {
  assert.equal(equilibrium(bars, 160).zone, 'PREMIUM');
});

test('reports distance to the swing extremes', () => {
  const e = equilibrium(bars, 110);
  assert.equal(Math.round(e.pctToLow * 100) / 100, 10);     // 10% above the low
  assert.equal(Math.round(e.pctToHigh * 100) / 100, 81.82); // 81.82% below the high
});

test('honours the lookback window', () => {
  const e = equilibrium(bars, 140, 2); // last 2 bars only: 120..170
  assert.equal(e.hh, 170);
  assert.equal(e.ll, 120);
});

test('returns null with no bars', () => {
  assert.equal(equilibrium([], 100), null);
});
