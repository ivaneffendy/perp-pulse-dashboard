import test from 'node:test';
import assert from 'node:assert/strict';
import { PAIRS, DEFAULT_WATCHLIST, resolvePair } from '../src/pairs.js';

test('defaults to the playbook section II watchlist', () => {
  assert.deepEqual(DEFAULT_WATCHLIST,
    ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB']);
});

test('every default watchlist entry exists in the allowlist', () => {
  for (const b of DEFAULT_WATCHLIST) assert.ok(PAIRS[b], `${b} missing from PAIRS`);
});

test('resolves a known base case-insensitively', () => {
  assert.equal(resolvePair('sol').base, 'SOL');
  assert.equal(resolvePair('SOL').bybit, 'SOLUSDT');
});

test('falls back to BTC for anything not on the allowlist', () => {
  // Guards against arbitrary ?symbol= strings reaching upstream URLs.
  assert.equal(resolvePair('../../etc/passwd').base, 'BTC');
  assert.equal(resolvePair('').base, 'BTC');
  assert.equal(resolvePair(null).base, 'BTC');
});

test('every pair carries all four venue identifiers', () => {
  for (const [base, p] of Object.entries(PAIRS)) {
    for (const k of ['bybit', 'okxInst', 'okxCcy', 'binance']) {
      assert.ok(p[k], `${base}.${k} missing`);
    }
  }
});
