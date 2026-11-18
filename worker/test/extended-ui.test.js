import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extendedHtml, trendContext } from '../../src/extended.js';

const item = (o) => ({
  base: 'SOL', turnover24h: 584e6, last: 104, side: 'long', protected: 90,
  extreme: 120, pctOfRange: 46.7, distToProtectedPct: -13.5, bosAgeBars: 4,
  status: 'in_zone', rsi4h: 50, ...o,
});
const body = (items) => ({ universeFiltered: true, items });

test('context: OB in an uptrend and OS in a downtrend are with trend', () => {
  assert.equal(trendContext(item({ side: 'long', rsi4h: 74 })), 'with_trend');
  assert.equal(trendContext(item({ side: 'short', rsi4h: 18 })), 'with_trend');
});

test('context: OS in an uptrend and OB in a downtrend are against trend', () => {
  assert.equal(trendContext(item({ side: 'long', rsi4h: 27 })), 'against_trend');
  assert.equal(trendContext(item({ side: 'short', rsi4h: 83 })), 'against_trend');
});

test('context: broken structure and no side are said, never guessed', () => {
  assert.equal(trendContext(item({ status: 'broken', rsi4h: 25 })), 'broken');
  assert.equal(trendContext(item({ status: 'unclear', side: null, rsi4h: 75 })), 'unclear');
  assert.equal(trendContext(item({ rsi4h: 55 })), null);
  assert.equal(trendContext(item({ rsi4h: null })), null);
});

test('only coins at an extreme are listed, most extreme first', () => {
  const html = extendedHtml(body([
    item({ base: 'AAA', rsi4h: 72 }), item({ base: 'BBB', rsi4h: 50 }),
    item({ base: 'CCC', rsi4h: 15, side: 'short' }), item({ base: 'DDD', rsi4h: 81, side: 'short' }),
  ]), { watchlist: ['AAA', 'BBB', 'CCC', 'DDD'] });
  assert.doesNotMatch(html, /BBB/);
  const order = [...html.matchAll(/cand-base">(\w+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['CCC', 'DDD', 'AAA']);
  assert.match(html, /15\.0/);
  assert.match(html, /extreme OS/);
  assert.match(html, /extreme OB/);
  assert.match(html, /with trend · late, don't chase/);
  assert.match(html, /against trend · needs 4H BOS/);
});

test('nothing at an extreme says so instead of rendering blank', () => {
  assert.match(extendedHtml(body([item()])), /No coin at 4H RSI/);
});

test('a failed fetch, and a Worker without RSI, say unavailable', () => {
  assert.match(extendedHtml(null), /Extended unavailable/);
  assert.match(extendedHtml(body([item({ rsi4h: undefined })])), /RSI unavailable/);
});

test('off-list is marked and the fetch time shown', () => {
  const html = extendedHtml(body([item({ rsi4h: 75 })]), { watchlist: [], asOf: '06:31:05' });
  assert.match(html, /off-list/);
  assert.match(html, /as of 06:31:05 WIB/);
});

test('the Extended module stays non-interactive, fetches nothing, never grades', () => {
  const src = readFileSync(new URL('../../src/extended.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick|fetch\(/i.test(src));
  assert.ok(!/score|verdict/i.test(src));
});

test('Extended rides the Candidates fetch: one loader renders both tabs', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /renderExtended\(d, fmtWib\(d\.ts\)\)/);
  assert.match(main, /renderExtended\(null\)/);
  assert.doesNotMatch(main, /fetchExtended/);
});
