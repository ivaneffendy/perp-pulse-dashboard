import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWalls } from '../src/compute/walls.js';

// Bids descending, asks ascending, [price, size].
function book(mid, spike) {
  const bids = [], asks = [];
  // 0.0004 steps keep all 20 levels strictly INSIDE the +/-0.5% band. At
  // 0.0005 the 10th level lands exactly on the edge, where float rounding
  // includes it on one side and excludes it on the other.
  for (let i = 1; i <= 20; i++) {
    bids.push([String(mid * (1 - i * 0.0004)), '1']);
    asks.push([String(mid * (1 + i * 0.0004)), '1']);
  }
  if (spike) asks[8][1] = '50'; // a clear outlier bin
  return { bids, asks };
}

test('returns null without both sides', () => {
  assert.equal(computeWalls([], [['1', '1']]), null);
  assert.equal(computeWalls(null, null), null);
});

test('reports a smooth side when no bin is an outlier', () => {
  const { bids, asks } = book(100, false);
  assert.equal(computeWalls(bids, asks).ask.nearestWall, null);
});

test('finds an outlier ask wall and reports it outward of mid', () => {
  const { bids, asks } = book(100, true);
  const w = computeWalls(bids, asks);
  assert.ok(w.ask.nearestWall);
  assert.ok(w.ask.nearestWall.distPct > 0);
});

test('imbalance is 50% on a symmetric book', () => {
  const { bids, asks } = book(100, false);
  assert.equal(Math.round(computeWalls(bids, asks).imbalancePct), 50);
});
