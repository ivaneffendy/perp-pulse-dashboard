import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMovers } from '../src/index.js';

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

/** Swaps global fetch for the duration of one test, then restores it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const bybitList = () => [
  { symbol: 'BTCUSDT', price24hPcnt: '0.01', turnover24h: '900000000' },
  { symbol: 'ARBUSDT', price24hPcnt: '0.22', turnover24h: '80000000' },
  { symbol: 'DUSTUSDT', price24hPcnt: '0.90', turnover24h: '10000' }, // below floor
  { symbol: 'BTCPERP', price24hPcnt: '0.01', turnover24h: '900000000' }, // not USDT-suffixed
];

const okxList = () => [
  { instId: 'BTC-USDT-SWAP', open24h: '79000', last: '79800', volCcy24h: '1000' },
  { instId: 'ASTER-USDT-SWAP', open24h: '0.60', last: '0.72', volCcy24h: '200000000' },
  { instId: 'BTC-USD-SWAP', open24h: '79000', last: '79800', volCcy24h: '1000' }, // coin-margined, excluded
];

test('returns ranked movers from Bybit', async () => {
  const res = await withFetch(
    async (u) => (String(u).includes('bybit.com')
      ? ok({ result: { list: bybitList() } })
      : (() => { throw new Error('OKX should not be called'); })()),
    () => handleMovers(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'Bybit linear');
  assert.equal(b.items.some((x) => x.base === 'BTC'), false); // baseline, excluded
  assert.equal(b.items.some((x) => x.base === 'DUST'), false); // below floor
  assert.ok(b.items.find((x) => x.base === 'ARB'));
  assert.equal(typeof b.ts, 'number');
});

test('falls back to OKX when Bybit is geo-blocked, converting volCcy24h to USD', async () => {
  const res = await withFetch(
    async (u) => {
      if (String(u).includes('bybit.com')) throw new Error('blocked by country');
      return ok({ data: okxList() });
    },
    () => handleMovers(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  // 200,000,000 volCcy * 0.72 last = $144,000,000 — clears the floor.
  assert.ok(b.items.find((x) => x.base === 'ASTER'));
  assert.equal(b.items.some((x) => x.base === 'BTC'), false);
});

test('reports 502 naming both venues when neither answers', async () => {
  const res = await withFetch(
    async (u) => { throw new Error(String(u).includes('bybit.com') ? 'bybit down' : 'okx down'); },
    () => handleMovers(),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.match(b.detail, /bybit down/);
  assert.match(b.detail, /okx down/);
});

test('CORS headers are present so the page can call it', async () => {
  const res = await withFetch(
    async () => ok({ result: { list: bybitList() } }),
    () => handleMovers(),
  );
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
