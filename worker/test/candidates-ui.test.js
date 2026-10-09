import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { candidatesHtml, shouldFetchCandidates } from '../../src/candidates.js';

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

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
  const html = candidatesHtml(body([item(), item({ base: 'ENA' })]), { watchlist: ['SOL'] });
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

test('the list shows when it was fetched', () => {
  assert.match(candidatesHtml(body([item()]), { asOf: '06:31:05' }), /as of 06:31:05 WIB/);
  assert.doesNotMatch(candidatesHtml(body([item()])), /as of/);
});

const want = (o) => shouldFetchCandidates({
  trigger: 'open', activeTab: 'candidates', loaded: false, inFlight: false, ...o,
});

test('opening the tab fetches once, then reuses what is on screen', () => {
  assert.equal(want({ trigger: 'open', loaded: false }), true);
  assert.equal(want({ trigger: 'open', loaded: true }), false);
});

test('Refresh refetches only while the Candidates tab is open', () => {
  assert.equal(want({ trigger: 'refresh', activeTab: 'candidates', loaded: true }), true);
  assert.equal(want({ trigger: 'refresh', activeTab: 'matrix', loaded: false }), false);
  assert.equal(want({ trigger: 'refresh', activeTab: 'chart', loaded: true }), false);
});

test('automatic reloads (timer, ETF toggle, tab return) never fetch candidates', () => {
  assert.equal(want({ trigger: 'auto', activeTab: 'candidates', loaded: false }), false);
});

test('nothing fetches while a candidates request is already in flight', () => {
  assert.equal(want({ trigger: 'open', inFlight: true }), false);
  assert.equal(want({ trigger: 'refresh', inFlight: true }), false);
});

test('the Refresh button is the only caller that passes the refresh trigger', () => {
  const main = src('../../src/main.js');
  assert.match(main, /\$\('refresh'\)\.addEventListener\('click', \(\) => load\('refresh'\)\)/);
  assert.equal((main.match(/load\('refresh'\)/g) ?? []).length, 1);
  assert.match(main, /async function load\(trigger = 'auto'\)/, 'every other caller defaults to auto');
  // fetchCandidates is reached only through loadCandidates, and every
  // loadCandidates call site is gated by shouldFetchCandidates.
  assert.equal((main.match(/fetchCandidates\(/g) ?? []).length, 0);
  assert.equal((main.match(/\.then\(fetchCandidates\)/g) ?? []).length, 1);
  const calls = main.match(/loadCandidates\(\);/g) ?? [];
  const gated = main.match(/shouldFetchCandidates\(\{[^}]*\}\)\) loadCandidates\(\);/g) ?? [];
  assert.ok(calls.length >= 2 && calls.length === gated.length, 'ungated loadCandidates() call');
});

test('Movers is gone: no tab, no module, no client fetch, no Worker route', () => {
  assert.equal(existsSync(new URL('../../src/movers.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/compute/movers.js', import.meta.url)), false);
  assert.doesNotMatch(src('../../index.html'), /tab-movers|movers-list/);
  assert.doesNotMatch(src('../../src/main.js'), /fetchMovers|renderMovers/);
  assert.doesNotMatch(src('../../src/api.js'), /fetchMovers|'\/movers'/);
  assert.doesNotMatch(src('../src/index.js'), /'\/movers'|handleMovers|rankMovers/);
});

test('the frontend candidates module stays non-interactive and never renders grading fields', () => {
  const src = readFileSync(new URL('../../src/candidates.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick/i.test(src));
  assert.ok(!/score|verdict/i.test(src));
});
