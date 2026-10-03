/**
 * Offline checks for dash_snapshot.js. No network: a fake fetch routes each
 * Worker path to an invented payload. Every price below is INVENTED -- this
 * repo is public.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, anchoredLtf } from './dash_snapshot.js';

const NOW = () => new Date('2026-01-01T00:00:00Z');

const ASSET = {
  symbol: 'FAKE', source: 'Fake venue', price: { mark: 101.5 },
  signals: {
    ema: { side: 1 },
    equilibrium: { hh: 120, ll: 80, eq: 100, zone: 'PREMIUM', pctOfRange: 53.75, pctToLow: 1 },
    mode: { mode: 'TREND', direction: -1 },
  },
  score: {
    total: -2, verdict: 'CHOPPY / RANGE',
    layers: [
      { key: 'etf', value: 0 }, { key: 'funding', value: -1 }, { key: 'oi', value: 0 },
      { key: 'ema', value: 1 }, { key: 'sweep', value: -1 },
    ],
  },
};

// 30 flat 4H bars with one swing high and one swing low -- enough for the
// liquidity scan to find something, invented throughout.
const BARS = Array.from({ length: 30 }, (_, i) => ({
  t: i * 14_400_000, o: 100, c: 100, v: 1,
  h: i === 10 ? 110 : 101, l: i === 20 ? 90 : 99,
}));

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const route = routes[url.pathname];
    if (route instanceof Error) return { ok: false, status: 502, json: async () => ({ error: route.message }) };
    return { ok: true, status: 200, json: async () => route(url) };
  };
  fn.calls = calls;
  return fn;
}

const happy = (overrides = {}) => fakeFetch({
  '/macro': () => ({ etfBtc: 32e6 }),
  '/asset': () => ASSET,
  '/ltf': () => ({ label: 'Quiet', rvol: 1.04, anchored: false }),
  '/candles': () => ({ bars: BARS, source: 'Fake venue' }),
  ...overrides,
});

test('a snapshot carries the verdict, layers, range, mode, LTF and liq line', async () => {
  const s = await snapshot('FAKE', { fetchFn: happy(), now: NOW });
  assert.equal(s.schema, 1);
  assert.equal(s.fetchedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(s.mark, 101.5);
  assert.deepEqual(s.score, {
    total: -2, verdict: 'CHOPPY / RANGE',
    layers: { etf: 0, funding: -1, oi: 0, ema: 1, sweep: -1 },
  });
  assert.equal(s.emaSide, 1);
  assert.deepEqual(s.equilibrium, { hh: 120, ll: 80, eq: 100, zone: 'PREMIUM', pctOfRange: 53.75 });
  assert.deepEqual(s.mode, { mode: 'TREND', direction: -1 });
  assert.deepEqual(s.ltf, { label: 'Quiet', rvol: 1.04, anchored: false });
  assert.match(s.liq, /^LIQ 4H FAKE \| /);
  assert.deepEqual(s.errors, []);
});

test('ETF is a proxy on every pair but BTC, and still relayed like the page does', async () => {
  const f = happy();
  const s = await snapshot('FAKE', { fetchFn: f, now: NOW });
  assert.deepEqual(s.etf, { source: 'proxy', usd: 32e6 });
  const asset = f.calls.find((u) => u.pathname === '/asset');
  assert.equal(asset.searchParams.get('etf'), '32000000');
});

test('BTC with a null /macro ETF is unknown, and /asset gets no etf param', async () => {
  const f = happy({ '/macro': () => ({ etfBtc: null }) });
  const s = await snapshot('BTC', { fetchFn: f, now: NOW });
  assert.deepEqual(s.etf, { source: 'unknown', usd: null });
  const asset = f.calls.find((u) => u.pathname === '/asset');
  assert.equal(asset.searchParams.get('etf'), null);
});

test('BTC with a live ETF figure is auto', async () => {
  const s = await snapshot('BTC', { fetchFn: happy(), now: NOW });
  assert.deepEqual(s.etf, { source: 'auto', usd: 32e6 });
});

test('a failed /macro is unknown ETF, not a failed snapshot', async () => {
  const s = await snapshot('BTC', { fetchFn: happy({ '/macro': new Error('down') }), now: NOW });
  assert.equal(s.etf.source, 'unknown');
  assert.equal(s.errors.length, 1);
});

test('a failed /candles degrades the liq line to null and says so', async () => {
  const s = await snapshot('FAKE', { fetchFn: happy({ '/candles': new Error('no candles') }), now: NOW });
  assert.equal(s.liq, null);
  assert.match(s.errors.join(), /no candles/);
  assert.equal(s.score.total, -2);
});

test('a failed /ltf degrades the LTF read to null', async () => {
  const s = await snapshot('FAKE', { fetchFn: happy({ '/ltf': new Error('ltf down') }), now: NOW });
  assert.equal(s.ltf, null);
});

test('a failed /asset is no snapshot at all', async () => {
  await assert.rejects(
    snapshot('FAKE', { fetchFn: happy({ '/asset': new Error('Not listed') }), now: NOW }),
    /Not listed/);
});

test('the anchored read passes the side and reports it', async () => {
  const f = happy({ '/ltf': (u) => ({ label: 'Absorbed', barsAgo: 3, anchored: u.searchParams.get('side') === 'short' }) });
  const a = await anchoredLtf('FAKE', 'short', { fetchFn: f, now: NOW });
  assert.deepEqual(a, {
    schema: 1, fetchedAt: '2026-01-01T00:00:00.000Z', symbol: 'FAKE', side: 'short',
    label: 'Absorbed', barsAgo: 3, anchored: true,
  });
});

test('the anchored read refuses anything but long or short', async () => {
  await assert.rejects(anchoredLtf('FAKE', 'up', { fetchFn: happy() }), /long or short/);
});
