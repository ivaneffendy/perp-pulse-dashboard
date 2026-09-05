import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAsset } from '../src/index.js';

/** Swaps global fetch for the duration of one test, then restores it. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const call = (sym = 'BTC') => handleAsset(new URL(`https://w/asset?symbol=${sym}`));

test('a known symbol whose venues are both down gets the friendly message, not the raw upstream dump', async () => {
  const res = await withFetch(
    async (u) => {
      throw new Error(String(u).includes('bybit.com')
        ? 'bybit down: CloudFront blocked' : 'okx down: rate limited');
    },
    () => call('BTC'),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.equal(b.error, 'No core source reachable');
  // The bug being fixed: `detail` used to duplicate the raw upstream text, and
  // api.js prefers `detail` over `error` when it picks the message a row
  // shows — so a verified §II coin got the developer text instead of this.
  assert.equal(b.detail, undefined);
  // Nothing is lost — the raw diagnostic text still exists, just under a key
  // the page never reads.
  assert.match(b.upstream, /bybit down/);
  assert.match(b.upstream, /okx down/);
});

test('an unlisted symbol still gets the plain not-listed message', async () => {
  const res = await withFetch(
    async () => { throw new Error('nope'); },
    () => call('ZZZZZ'),
  );
  assert.equal(res.status, 502);
  const b = await res.json();
  assert.equal(b.error, 'Not listed on Bybit or OKX');
  assert.equal(b.detail, undefined);
});
