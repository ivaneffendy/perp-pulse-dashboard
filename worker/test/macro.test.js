import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDominance, parseFarsideTotal } from '../src/sources/macro.js';

test('derives TOTAL3 by excluding BTC and ETH dominance', () => {
  const d = parseDominance({
    data: {
      total_market_cap: { usd: 1000 },
      market_cap_percentage: { btc: 50, eth: 10, usdt: 5 },
    },
  });
  assert.equal(d.btcD, 50);
  assert.equal(d.usdtD, 5);
  assert.equal(d.total3, 400); // 1000 * (100-50-10)/100
});

test('returns null for a malformed dominance payload', () => {
  assert.equal(parseDominance({}), null);
  assert.equal(parseDominance(null), null);
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
