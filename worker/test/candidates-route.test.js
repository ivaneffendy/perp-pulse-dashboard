import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCandidates } from '../src/index.js';

const H4 = 4 * 60 * 60 * 1000;
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// The same up-BOS leg as anchored.test.js's A (protected 90, extreme 120),
// padded with flat bars to clear the default 20-bar minimum. Returned as
// venue rows, newest first, every bar already closed.
const LEG = [
  ...Array.from({ length: 6 }, () => [101, 99, 100]),
  [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
  [106, 100, 101], [104, 95, 96], [100, 90, 92], [104, 93, 103],
  [108, 100, 107], [109, 104, 108], [113, 107, 112], [120, 111, 118],
  [118, 112, 114], [116, 108, 109], [112, 104, 105],
];
const rows = () => {
  const end = Math.floor(Date.now() / H4) * H4;
  return LEG.map(([h, l, c], i) => [
    String(end - (LEG.length - i) * H4), String(c), String(h), String(l), String(c), '1', '1',
  ]).reverse();
};

const bybitT = (symbol, turnover24h, lastPrice) =>
  ({ symbol: `${symbol}USDT`, price24hPcnt: '0.01', turnover24h: String(turnover24h), lastPrice: String(lastPrice) });

const TICKERS = [
  bybitT('BTC', 3e9, 104),   // in zone (46.7%)
  bybitT('ETH', 2e9, 112),   // outside (73.3%)
  bybitT('SOL', 5e8, 89),    // broken (through 90)
  bybitT('XAU', 6e8, 104),   // not in top100
  bybitT('BTW', 2e8, 104),   // excluded
  bybitT('DUST', 5e7, 104),  // below the floor
];

const symbolOf = (u) => new URL(String(u)).searchParams.get('symbol')
  ?? new URL(String(u)).searchParams.get('instId');

/** Records every upstream URL; routes tickers vs klines by path. */
function venue({ tickers = TICKERS, kline = () => ok({ result: { list: rows() } }) } = {}) {
  const calls = [];
  const impl = async (u) => {
    calls.push(String(u));
    if (String(u).includes('/market/tickers')) return ok({ result: { list: tickers } });
    return kline(u);
  };
  return { calls, impl };
}

const CAND = 'https://x.test/candidates?top100=BTC,ETH,SOL,BTW,DUST&exclude=BTW';

test('screens the filtered universe and sorts in_zone, outside, broken', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'Bybit linear');
  assert.deepEqual(b.items.map((x) => x.base), ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(b.items.map((x) => x.status), ['in_zone', 'outside', 'broken']);
  assert.equal(b.items[0].side, 'long');
  assert.equal(b.items[0].protected, 90);
  assert.equal(b.items[0].last, 104);
  assert.equal(b.universeFiltered, true);
  assert.deepEqual(b.excluded, ['BTW']);
  assert.deepEqual(b.criterion, { turnoverFloor: 100_000_000, swingWidth: 3 });
  assert.equal(v.calls.length, 1 + 3, 'one tickers call plus one kline call per coin');
});

test('item keys are exactly the documented shape, with no scoring leakage', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  const raw = await res.text();
  assert.ok(!/score|verdict|layers|bias/i.test(raw));
  for (const item of JSON.parse(raw).items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'base', 'bosAgeBars', 'distToProtectedPct', 'extreme', 'last', 'pctOfRange',
      'protected', 'side', 'status', 'turnover24h',
    ]);
  }
});

test('klines come from the venue that served the tickers (OKX when Bybit is blocked)', async () => {
  const calls = [];
  const impl = async (u) => {
    calls.push(String(u));
    if (String(u).includes('bybit.com')) throw new Error('blocked by country');
    if (String(u).includes('/market/tickers')) {
      return ok({ data: [{ instId: 'BTC-USDT-SWAP', open24h: '100', last: '104', volCcy24h: '2000000' }] });
    }
    return ok({ data: rows() });
  };
  const res = await withFetch(impl, () => handleCandidates(new URL('https://x.test/candidates?top100=BTC')));
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  assert.equal(b.items[0].status, 'in_zone');
  const klineCalls = calls.filter((u) => !u.includes('/market/tickers'));
  assert.equal(klineCalls.length, 1);
  assert.ok(klineCalls.every((u) => u.includes('okx.com')));
});

test('one coin failing its klines is listed as error; the rest still return', async () => {
  const v = venue({
    kline: (u) => (symbolOf(u) === 'ETHUSDT'
      ? new Response('upstream exploded', { status: 500 })
      : ok({ result: { list: rows() } })),
  });
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  const eth = b.items.find((x) => x.base === 'ETH');
  assert.equal(eth.status, 'error');
  assert.match(eth.detail, /500/);
  assert.equal(b.items.at(-1).base, 'ETH', 'errors sort last');
  assert.equal(v.calls.length, 1 + 3, 'no retries on the kline fan-out');
});

test('a geo-block across the whole fan-out stays inside the subrequest budget', async () => {
  const tickers = Array.from({ length: 25 }, (_, i) => bybitT(`C${String(i).padStart(2, '0')}`, 1e9 - i * 1e6, 1));
  const v = venue({ tickers, kline: () => new Response('blocked', { status: 403 }) });
  const res = await withFetch(v.impl, () => handleCandidates(new URL('https://x.test/candidates')));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.items.length, 20, 'capped at 20');
  assert.ok(b.items.every((x) => x.status === 'error'));
  assert.ok(!b.items.some((x) => ['C20', 'C21', 'C22', 'C23', 'C24'].includes(x.base)), 'top 20 by turnover');
  assert.equal(v.calls.length, 21);
  assert.ok(v.calls.length <= 50);
});

test('a venue answering with no bars for a coin is an error row, not a thrown route', async () => {
  const v = venue({ kline: () => ok({ result: { list: [] } }) });
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.ok(b.items.every((x) => x.status === 'error'));
});

test('without top100 the universe is unfiltered, and the response says so', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL('https://x.test/candidates?exclude=BTW')));
  const b = await res.json();
  assert.equal(b.universeFiltered, false);
  assert.ok(b.items.some((x) => x.base === 'XAU'));
  assert.ok(!b.items.some((x) => x.base === 'BTW'));
});

test('reports 502 naming both venues when neither serves tickers', async () => {
  const res = await withFetch(
    async (u) => { throw new Error(String(u).includes('bybit.com') ? 'bybit down' : 'okx down'); },
    () => handleCandidates(new URL(CAND)),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.match(b.detail, /bybit down/);
  assert.match(b.detail, /okx down/);
});

test('CORS headers are present', async () => {
  const v = venue();
  const res = await withFetch(v.impl, () => handleCandidates(new URL(CAND)));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
