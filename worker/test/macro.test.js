import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDominance, parseFarsideTotal } from '../src/sources/macro.js';

const tick = (sym, mc) => ({ symbol: sym, quotes: { USD: { market_cap: mc } } });
const TICKERS = [tick('BTC', 500), tick('ETH', 100), tick('USDT', 50)];

test('derives dominance and TOTAL3 from raw market caps', () => {
  const d = parseDominance({ market_cap_usd: 1000 }, TICKERS);
  assert.equal(d.btcD, 50);
  assert.equal(d.ethD, 10);
  assert.equal(d.usdtD, 5);
  assert.equal(d.total3, 400); // 1000 - 500 - 100, excluding BTC and ETH
  assert.equal(d.totalMcap, 1000);
});

test('tolerates a missing USDT ticker without failing the whole read', () => {
  const d = parseDominance({ market_cap_usd: 1000 }, [tick('BTC', 500), tick('ETH', 100)]);
  assert.equal(d.usdtD, null);
  assert.equal(d.btcD, 50);
});

test('returns null for a malformed dominance payload', () => {
  assert.equal(parseDominance({}, TICKERS), null);
  assert.equal(parseDominance(null, TICKERS), null);
  assert.equal(parseDominance({ market_cap_usd: 1000 }, null), null);
  assert.equal(parseDominance({ market_cap_usd: 0 }, TICKERS), null);
});

test('reads the last dated row total from a Farside table', () => {
  const html = `<table>
    <tr><td>01 Jan 2026</td><td>10.0</td><td>120.5</td></tr>
    <tr><td>02 Jan 2026</td><td>5.0</td><td>(87.3)</td></tr>
    <tr><td>Total</td><td>15.0</td><td>33.2</td></tr>
  </table>`;
  // Last DATED row is 02 Jan; (87.3) is an accounting negative, in $m.
  assert.equal(parseFarsideTotal(html), -87.3e6);
});

test('returns null when no dated row is present', () => {
  assert.equal(parseFarsideTotal('<table><tr><td>Total</td><td>5</td></tr></table>'), null);
  assert.equal(parseFarsideTotal(''), null);
});
