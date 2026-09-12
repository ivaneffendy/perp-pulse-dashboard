import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCandles } from '../src/index.js';

const H4 = 4 * 60 * 60 * 1000;
const NOW = 1_780_000_000_000;

/** Venue rows are [ts, o, h, l, c, v, ...] on BOTH venues, newest-first. */
function rows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - i) * H4;
    out.push([t, 100, 101, 99, 100.5, 10]);
  }
  return out.reverse().map((r) => r.map(String));
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const call = (qs = 'symbol=BTC') => handleCandles(new URL(`https://w/candles?${qs}`));

test('serves normalized oldest-first bars from Bybit', async () => {
  const res = await withFetch(
    async (u) => (String(u).includes('bybit.com')
      ? ok({ result: { list: rows(90) } })
      : (() => { throw new Error('OKX should not be called'); })()),
    () => call(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.symbol, 'BTC');
  assert.equal(b.source, 'Bybit linear');
  assert.equal(b.interval, '4H');
  assert.ok(b.bars.length >= 30);
  // Oldest-first, numeric — every compute module downstream assumes both.
  assert.ok(b.bars[0].t < b.bars[b.bars.length - 1].t);
  assert.equal(typeof b.bars[0].c, 'number');
});

test('requests the 4H interval, not the LTF one', async () => {
  let seen = '';
  await withFetch(
    async (u) => { seen = String(u); return ok({ result: { list: rows(90) } }); },
    () => call(),
  );
  assert.match(seen, /interval=240/);
});

test('falls back to OKX when Bybit fails', async () => {
  const res = await withFetch(
    async (u) => (String(u).includes('bybit.com')
      ? new Response('blocked', { status: 403 })
      : ok({ data: rows(90) })),
    () => call(),
  );
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  assert.ok(b.bars.length >= 30);
});

test('502 naming both venues when neither can serve', async () => {
  const res = await withFetch(
    async () => new Response('nope', { status: 500 }),
    () => call(),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.match(b.detail, /bybit:/);
  assert.match(b.detail, /okx:/);
});

test('an invalid symbol is refused, never substituted', async () => {
  const res = await withFetch(
    async () => { throw new Error('no upstream call should happen'); },
    () => call('symbol=BTC%26limit%3D9999'),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid symbol');
});

test('limit is clamped, so a caller cannot ask for an unbounded payload', async () => {
  for (const [asked, expected] of [['9999', 200], ['1', 30], ['abc', 90]]) {
    let seen = '';
    await withFetch(
      async (u) => { seen = String(u); return ok({ result: { list: rows(220) } }); },
      () => call(`symbol=BTC&limit=${asked}`),
    );
    assert.match(seen, new RegExp(`limit=${expected}(&|$)`), `limit=${asked} -> ${expected}`);
  }
});

test('the route computes no signals — it returns bars only', async () => {
  const res = await withFetch(
    async () => ok({ result: { list: rows(90) } }),
    () => call(),
  );
  const b = await res.json();
  // equilibrium/FVG/OB/mode are derived in the browser from these same bars.
  for (const k of ['score', 'signals', 'equilibrium', 'fvg', 'mode', 'orderblock']) {
    assert.ok(!(k in b), `/candles must not carry ${k}`);
  }
});
