import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../src/verdict.js';

const base = { chg1h: 0, oiD1h: 0, funding: 0.005, taker: null, book: null };

test('price down + OI down reads as healthy deleveraging', () => {
  const v = verdict({ ...base, chg1h: -0.5, oiD1h: -1 });
  assert.equal(v.cls, 'ok');
  assert.match(v.msg, /deleverag/i);
});

test('price down + OI up reads as fresh shorts and is flagged risk', () => {
  const v = verdict({ ...base, chg1h: -0.5, oiD1h: 1 });
  assert.equal(v.cls, 'risk');
});

test('DIVERGENCE IS INTENTIONAL: this contradicts score.js by design', () => {
  // §VII scores price-down + OI-down as -1 (long flush); verdict() calls the
  // same state 'ok'. They answer different questions. If this test ever fails
  // because someone "fixed" the inconsistency, read the spec first.
  assert.equal(verdict({ ...base, chg1h: -0.5, oiD1h: -1 }).cls, 'ok');
});

test('flat hour falls through to mixed', () => {
  assert.equal(verdict(base).cls, 'mixed');
});
