import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlashes, fetchFlashes, MKTNEWS_URL } from '../src/sources/mktnews.js';

const RAW_ITEM = {
  id: 'abc',
  time: '2026-09-28T07:24:13.000Z',
  important: 1,
  data: { title: null, content: 'Spot gold fell 3.00% intraday to $4,156.57/oz.' },
};

test('normalizeFlashes parses time to epoch ms and coerces important to boolean', () => {
  const out = normalizeFlashes([RAW_ITEM]);
  assert.deepEqual(out, [{
    id: 'abc',
    ts: Date.parse('2026-09-28T07:24:13.000Z'),
    important: true,
    content: 'Spot gold fell 3.00% intraday to $4,156.57/oz.',
  }]);
});

test('normalizeFlashes reads important: 0 as false', () => {
  const out = normalizeFlashes([{ ...RAW_ITEM, important: 0 }]);
  assert.equal(out[0].important, false);
});

test('normalizeFlashes drops items with an unparseable time', () => {
  const out = normalizeFlashes([{ ...RAW_ITEM, time: 'not-a-date' }]);
  assert.deepEqual(out, []);
});

test('normalizeFlashes drops items with no content', () => {
  const out = normalizeFlashes([{ ...RAW_ITEM, data: { content: '' } }]);
  assert.deepEqual(out, []);
});

test('normalizeFlashes tolerates a non-array payload', () => {
  assert.deepEqual(normalizeFlashes(null), []);
  assert.deepEqual(normalizeFlashes(undefined), []);
});

test('fetchFlashes fetches the flash feed URL and normalizes the result', async () => {
  let seenUrl = null;
  const j = async (url) => { seenUrl = url; return [RAW_ITEM]; };
  const out = await fetchFlashes(j);
  assert.equal(seenUrl, MKTNEWS_URL);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'abc');
});
