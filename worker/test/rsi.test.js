import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rsi, rsiZone, RSI } from '../src/compute/rsi.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fewer than period + 1 closes is null, not a number', () => {
  assert.equal(rsi(Array(14).fill(100)), null);
  assert.equal(rsi(null), null);
  assert.equal(rsi([1, 2, NaN, ...Array(20).fill(3)]), null);
});

test('flat closes are 50, only-up is 100, only-down is 0', () => {
  assert.equal(rsi(Array(30).fill(100)), 50);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  assert.equal(rsi(Array.from({ length: 30 }, (_, i) => 100 - i)), 0);
});

// The widely cited 15-close RSI teaching series (the StockCharts/Wilder
// worked example): first RSI 70.46, then 66.25 and 66.48 on the next two
// closes. Public reference data, not market prices of any trade.
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
  45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];

test('matches the published seed value on the classic 15-close series', () => {
  close(rsi(WILDER), 70.46, 0.01);
});

test('smoothing continues past the seed (next published values 66.25, 66.48)', () => {
  close(rsi([...WILDER, 46.00]), 66.25, 0.01);
  close(rsi([...WILDER, 46.00, 46.03]), 66.48, 0.01);
});

test('zones: 80 / 70 / 30 / 20 are inclusive edges', () => {
  assert.deepEqual(RSI, { period: 14, ob: 70, os: 30, extremeOb: 80, extremeOs: 20 });
  assert.equal(rsiZone(80), 'extreme_ob');
  assert.equal(rsiZone(79.9), 'ob');
  assert.equal(rsiZone(70), 'ob');
  assert.equal(rsiZone(69.9), null);
  assert.equal(rsiZone(30.1), null);
  assert.equal(rsiZone(30), 'os');
  assert.equal(rsiZone(20.1), 'os');
  assert.equal(rsiZone(20), 'extreme_os');
  assert.equal(rsiZone(null), null);
  assert.equal(rsiZone(undefined), null);
});

test('RSI never enters scoring', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(!/['"][^'"]*\/rsi\.js['"]/.test(src),
      `${p} imports rsi.js — the extension read must never enter scoring`);
  }
});
