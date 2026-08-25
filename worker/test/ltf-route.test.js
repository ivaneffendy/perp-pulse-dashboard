import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLtf } from '../src/index.js';

const M15 = 15 * 60 * 1000;
const NOW = 1_780_000_000_000;
const BARS = 40;

/**
 * Venue rows are [ts, o, h, l, c, v, ...] on BOTH venues, newest-first.
 * The newest bar closes exactly at NOW, so nothing is forming and the read is
 * deterministic.
 */
function rows({ hot }) {
  const out = [];
  for (let i = 0; i < BARS; i++) {
    const t = NOW - (BARS - i) * M15;
    out.push(i === BARS - 1 && hot
      ? [t, 102, 105, 95, 104, 300]      // heavy bar, dominant lower wick
      : [t, 100, 100.2, 99.8, 100, 100]); // quiet baseline
  }
  return out.reverse().map((r) => r.map(String));
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

/** Swaps global fetch for the duration of one test, then restores it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const call = (sym = 'BTC') => handleLtf(new URL(`https://w/ltf?symbol=${sym}`));

test('returns the documented shape from Bybit', async () => {
  const res = await withFetch(
    async (u) => (String(u).includes('bybit.com')
      ? ok({ result: { list: rows({ hot: true }) } })
      : (() => { throw new Error('OKX should not be called'); })()),
    () => call(),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.symbol, 'BTC');
  assert.equal(b.source, 'Bybit linear');
  assert.equal(b.interval, '15m');
  assert.equal(b.cls, 'absorbed');
  assert.equal(b.side, 1);
  assert.ok(b.rvol > 1);
  assert.ok(b.label && b.msg);
  assert.ok(b.bar && b.bar.v === 300);
  assert.equal(typeof b.ts, 'number');
});

test('falls back to OKX when Bybit is geo-blocked', async () => {
  // The whole reason this fallback exists: Bybit's CDN blocks the edge exactly
  // when the rest of the dashboard is already degraded.
  const res = await withFetch(
    async (u) => {
      if (String(u).includes('bybit.com')) throw new Error('blocked by country');
      return ok({ data: rows({ hot: true }) });
    },
    () => call('SOL'),
  );
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.source, 'OKX SWAP');
  assert.equal(b.cls, 'absorbed');
});

test('reports 502 naming both venues when neither answers', async () => {
  const res = await withFetch(
    async (u) => { throw new Error(String(u).includes('bybit.com') ? 'bybit down' : 'okx down'); },
    () => call(),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  // Failures are never swallowed into a silent empty read.
  assert.match(b.detail, /bybit down/);
  assert.match(b.detail, /okx down/);
});

test('a quiet market reports quiet, not a fabricated signal', async () => {
  const res = await withFetch(
    async () => ok({ result: { list: rows({ hot: false }) } }),
    () => call(),
  );
  const b = await res.json();
  assert.equal(b.cls, 'quiet');
  assert.equal(b.side, 0);
});

test('CORS headers are present so the page can call it', async () => {
  const res = await withFetch(
    async () => ok({ result: { list: rows({ hot: true }) } }),
    () => call(),
  );
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
