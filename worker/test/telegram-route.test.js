import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegram } from '../src/index.js';

const ENV = { TELEGRAM_BOT_TOKEN: 'tok123', TELEGRAM_OWNER_CHAT_ID: '999' };

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const update = (overrides = {}) => new Request('https://w/telegram', {
  method: 'POST',
  body: JSON.stringify({
    message: { chat: { id: 999 }, text: '/digest', ...overrides.message },
    ...overrides,
  }),
});

const flashAt = (id, minutesAgo, important, content = `flash ${id}`) => ({
  id,
  time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  important,
  data: { content },
});

test('ignores an update from any chat other than the configured owner', async () => {
  let telegramCalled = false;
  const res = await withFetch(
    async (u) => {
      if (String(u).includes('api.telegram.org')) telegramCalled = true;
      if (String(u).includes('static.mktnews.net')) throw new Error('should not fetch flashes for a non-owner');
      return ok([]);
    },
    () => handleTelegram(update({ message: { chat: { id: 1 }, text: '/digest' } }), ENV),
  );
  assert.equal(res.status, 200);
  assert.equal(telegramCalled, false);
});

test('ignores a message from the owner that is not the /digest command', async () => {
  let telegramCalled = false;
  await withFetch(
    async (u) => {
      if (String(u).includes('api.telegram.org')) telegramCalled = true;
      return ok([]);
    },
    () => handleTelegram(update({ message: { chat: { id: 999 }, text: 'hello' } }), ENV),
  );
  assert.equal(telegramCalled, false);
});

test('on /digest from the owner, fetches flashes and replies with the digest text', async () => {
  let sentBody = null;
  await withFetch(
    async (u, opts) => {
      if (String(u).includes('static.mktnews.net')) {
        return ok([flashAt('a', 30, 1, 'Oil rally intensifies Fed-hike bets')]);
      }
      if (String(u).includes('api.telegram.org')) {
        assert.match(String(u), /\/bottok123\/sendMessage$/);
        sentBody = JSON.parse(opts.body);
        return ok({ ok: true });
      }
      throw new Error(`unexpected fetch to ${u}`);
    },
    () => handleTelegram(update(), ENV),
  );
  assert.equal(sentBody.chat_id, 999);
  assert.match(sentBody.text, /Oil rally intensifies Fed-hike bets/);
  assert.match(sentBody.text, /1 important flash/);
});

test('when the flash feed fetch fails, replies with an error instead of going silent', async () => {
  let sentBody = null;
  await withFetch(
    async (u, opts) => {
      if (String(u).includes('static.mktnews.net')) return new Response('blocked', { status: 403 });
      if (String(u).includes('api.telegram.org')) { sentBody = JSON.parse(opts.body); return ok({ ok: true }); }
      throw new Error(`unexpected fetch to ${u}`);
    },
    () => handleTelegram(update(), ENV),
  );
  assert.match(sentBody.text, /couldn't fetch/i);
});

test('rejects a malformed webhook body', async () => {
  const bad = new Request('https://w/telegram', { method: 'POST', body: 'not json' });
  const res = await handleTelegram(bad, ENV);
  assert.equal(res.status, 400);
});
