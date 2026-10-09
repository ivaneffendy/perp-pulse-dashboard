import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesHtml } from '../../src/candidates.js';

const item = (o) => ({
  base: 'SOL', turnover24h: 584e6, last: 104, side: 'long', protected: 90,
  extreme: 120, pctOfRange: 46.7, distToProtectedPct: -13.5, bosAgeBars: 4,
  status: 'in_zone', ...o,
});
const body = (items, extra = {}) => ({ universeFiltered: true, items, ...extra });

test('a failed fetch says unavailable', () => {
  assert.match(candidatesHtml(null), /Candidates unavailable/);
});

test('an empty list says nothing cleared, rather than rendering blank', () => {
  assert.match(candidatesHtml(body([])), /Nothing cleared the criterion/);
});

test('a ranged row shows side, status, percent, protected point and BOS age', () => {
  const html = candidatesHtml(body([item()]));
  assert.match(html, /LONG/);
  assert.match(html, /in zone/);
  assert.match(html, /47%/);
  assert.match(html, /prot 90/);
  assert.match(html, /BOS 16h/);
  assert.match(html, /\$584M/);
});

test('off-list is marked for coins outside the watchlist only', () => {
  const html = candidatesHtml(body([item(), item({ base: 'ENA' })]), ['SOL']);
  assert.equal((html.match(/off-list/g) ?? []).length, 1);
  assert.match(html, /ENA[\s\S]*off-list/);
});

test('a broken row shows no percent and no protected point', () => {
  const html = candidatesHtml(body([item({ status: 'broken', pctOfRange: -3 })]));
  assert.match(html, /broken/);
  assert.doesNotMatch(html, /%<\/span>/);
  assert.doesNotMatch(html, /prot /);
});

test('upstream error text never reaches the markup', () => {
  const html = candidatesHtml(body([item({
    status: 'error', side: null, protected: null, pctOfRange: null,
    distToProtectedPct: null, bosAgeBars: null, detail: '<img src=x onerror=alert(1)>',
  })]));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /error/);
});

test('an unfiltered universe shows the warning banner', () => {
  assert.match(candidatesHtml(body([item()], { universeFiltered: false })), /unfiltered/);
  assert.doesNotMatch(candidatesHtml(body([item()])), /unfiltered/);
});

test('/candidates is requested only after the matrix fan-out settles', () => {
  // Its 20-call kline burst from the same edge, concurrent with the /asset
  // pool, is the burst shape api.js documents taking out several matrix rows.
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const matrixAt = src.indexOf('await fetchMatrix(');
  const candidatesAt = src.indexOf('.then(fetchCandidates)');
  assert.ok(matrixAt > 0 && candidatesAt > 0);
  assert.ok(candidatesAt > matrixAt, 'fetchCandidates must fire after await fetchMatrix(...)');
});

test('the frontend candidates module stays non-interactive and never renders grading fields', () => {
  const src = readFileSync(new URL('../../src/candidates.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick/i.test(src));
  assert.ok(!/score|verdict/i.test(src));
});
