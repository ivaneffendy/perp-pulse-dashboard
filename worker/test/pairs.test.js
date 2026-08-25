import test from 'node:test';
import assert from 'node:assert/strict';
import { PAIRS, DEFAULT_WATCHLIST, resolvePair } from '../src/pairs.js';

test('defaults to the playbook section II watchlist', () => {
  assert.deepEqual(DEFAULT_WATCHLIST,
    ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB']);
});

test('every default watchlist entry exists in the known set', () => {
  for (const b of DEFAULT_WATCHLIST) assert.ok(PAIRS[b], `${b} missing from PAIRS`);
});

test('resolves a known base case-insensitively', () => {
  assert.equal(resolvePair('sol').base, 'SOL');
  assert.equal(resolvePair('SOL').bybit, 'SOLUSDT');
  assert.equal(resolvePair('  sol  ').base, 'SOL');
});

test('flags whether the base is on the verified-coverage list', () => {
  assert.equal(resolvePair('BTC').known, true);
  // Venue coverage is only VERIFIED for PAIRS; anything else is derived and may
  // simply not list, which degrades to a failed row rather than bad data.
  assert.equal(resolvePair('PEPE').known, false);
});

test('derives venue identifiers for a coin outside the known set', () => {
  const p = resolvePair('PEPE');
  assert.equal(p.bybit, 'PEPEUSDT');
  assert.equal(p.okxInst, 'PEPE-USDT-SWAP');
  assert.equal(p.okxCcy, 'PEPE');
  assert.equal(p.binance, 'PEPEUSDT');
});

test('accepts leading digits, which real tickers use', () => {
  assert.equal(resolvePair('1000PEPE').bybit, '1000PEPEUSDT');
});

test('REJECTS anything that could reach an upstream URL as more than a symbol', () => {
  // This replaces the old silent BTC fallback. Substituting BTC for a bad
  // symbol was safe against injection but served one coin's numbers under
  // another coin's name — the worst outcome for a custom-symbol field.
  for (const bad of [
    '../../etc/passwd',
    'BTC&limit=9999',
    'BTC?x=1',
    'BTC/USDT',
    'BTC USDT',
    'BTC#frag',
    'BTC%2F',
    'B',                    // too short
    'A'.repeat(16),         // too long
    'BTC-USDT',
    'btc.usdt',
    '',
    null,
    undefined,
  ]) {
    assert.equal(resolvePair(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('every known pair carries all four venue identifiers', () => {
  for (const [base, p] of Object.entries(PAIRS)) {
    for (const k of ['bybit', 'okxInst', 'okxCcy', 'binance']) {
      assert.ok(p[k], `${base}.${k} missing`);
    }
  }
});
