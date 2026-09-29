import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDigest, formatDigestMessage } from '../src/compute/digest.js';

const H = 3600_000;
const NOW = 1_790_000_000_000; // arbitrary fixed epoch ms

const item = (id, hoursAgo, important, content = `flash ${id}`) => ({
  id, ts: NOW - hoursAgo * H, important, content,
});

test('selectDigest keeps only important items within the lookback window', () => {
  const items = [
    item('a', 1, true),
    item('b', 2, false), // not important — excluded from items
    item('c', 8, true), // outside a 6h window — excluded
  ];
  const { items: out } = selectDigest(items, { now: NOW, hours: 6 });
  assert.deepEqual(out.map((i) => i.id), ['a']);
});

test('selectDigest sorts kept items newest-first', () => {
  const items = [item('old', 5, true), item('new', 1, true), item('mid', 3, true)];
  const { items: out } = selectDigest(items, { now: NOW, hours: 6 });
  assert.deepEqual(out.map((i) => i.id), ['new', 'mid', 'old']);
});

test('selectDigest reports the actual span covered by ALL in-window items, not just important ones', () => {
  // The important item is only 1h old, but a non-important item reaches back
  // 5h — the feed genuinely held 5h of data, and the digest should say so
  // rather than under-reporting its own reach.
  const items = [item('a', 1, true), item('b', 5, false)];
  const { spanMs } = selectDigest(items, { now: NOW, hours: 6 });
  assert.equal(spanMs, 5 * H);
});

test('selectDigest caps the reported span at the requested lookback window', () => {
  const items = [item('a', 1, true), item('b', 20, false)]; // b is outside the window
  const { spanMs } = selectDigest(items, { now: NOW, hours: 6 });
  assert.equal(spanMs, 1 * H); // only 'a' is in-window; 'b' never counted
});

test('selectDigest on an empty feed returns no items and zero span', () => {
  assert.deepEqual(selectDigest([], { now: NOW, hours: 6 }), { items: [], spanMs: 0 });
});

test('formatDigestMessage lists each item with a WIB time and the content', () => {
  const digest = { items: [item('a', 1, true, 'Fed hikes bets rise')], spanMs: 1 * H };
  const msg = formatDigestMessage(digest, { hours: 6 });
  assert.match(msg, /1 important flash, last 1h:/);
  assert.match(msg, /Fed hikes bets rise/);
});

test('formatDigestMessage pluralizes the count', () => {
  const digest = { items: [item('a', 1, true), item('b', 2, true)], spanMs: 2 * H };
  const msg = formatDigestMessage(digest, { hours: 6 });
  assert.match(msg, /^2 important flashes, last 2h:/);
});

test('formatDigestMessage states the requested window was wider than the feed could cover', () => {
  const digest = { items: [], spanMs: 40 * 60_000 }; // feed only reached back 40 minutes
  const msg = formatDigestMessage(digest, { hours: 6 });
  assert.match(msg, /No important flashes/);
  assert.match(msg, /last 40m/);
  assert.match(msg, /asked for 6h/);
});

test('formatDigestMessage truncates and notes how many more were cut, when over the max length', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(`i${i}`, 1, true, `flash number ${i} `.repeat(5)));
  const digest = { items, spanMs: 1 * H };
  const msg = formatDigestMessage(digest, { hours: 6, maxLength: 500 });
  assert.ok(msg.length <= 500);
  assert.match(msg, /…and \d+ more/);
});
