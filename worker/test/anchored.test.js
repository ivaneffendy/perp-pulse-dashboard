import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anchoredRange, swings, ANCHORED } from '../src/compute/anchored.js';
import { normalizeKlines, INTERVAL_4H } from '../src/compute/klines.js';

const mk = (rows) => rows.map(([h, l, c]) => ({ o: c, h, l, c }));
const OPTS = { swingWidth: 3, minBars: 10 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// Swing high 110 at i3, swing low 90 at i6, close 112 > 110 at i10 (up-BOS,
// protected low 90), swing high 120 at i11, pullback to 104.
const A = [
  [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
  [106, 100, 101], [104, 95, 96], [100, 90, 92], [104, 93, 103],
  [108, 100, 107], [109, 104, 108], [113, 107, 112], [120, 111, 118],
  [118, 112, 114], [116, 108, 109], [112, 104, 105],
];

test('an up-BOS anchors from the leg-origin wick low to the latest high', () => {
  const r = anchoredRange(mk(A), 104, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.extreme, 120);
  close(r.pctOfRange, (104 - 90) / 30 * 100);
  assert.equal(r.status, 'in_zone');
  assert.equal(r.bosAgeBars, 4);
  close(r.distToProtectedPct, (90 / 104 - 1) * 100);
});

test('a long above 50% of the range is outside', () => {
  const r = anchoredRange(mk(A), 112, OPTS);
  assert.equal(r.status, 'outside');
  close(r.pctOfRange, (112 - 90) / 30 * 100);
});

test('a live price beyond the extreme extends it rather than going past 100%', () => {
  const r = anchoredRange(mk(A), 125, OPTS);
  assert.equal(r.extreme, 125);
  close(r.pctOfRange, 100);
  assert.equal(r.status, 'outside');
});

test('a live price through the protected low is broken, still long until a bar closes', () => {
  const r = anchoredRange(mk(A), 89, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.status, 'broken');
});

test('a wick through the protected low without a close does not flip', () => {
  const r = anchoredRange(mk([...A, [106, 88, 95]]), 95, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.status, 'in_zone');
});

test('a body close through the protected low flips short, anchored at the leg high', () => {
  const r = anchoredRange(mk([...A, [106, 85, 87]]), 87, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 120);
  assert.equal(r.extreme, 85);
  assert.equal(r.bosAgeBars, 0);
  assert.equal(r.status, 'outside'); // 5.7% of the range: not premium
});

test('closing below an internal swing low above the protected low is not a break', () => {
  // Swing low 104 at i14 becomes known at i18; i18 closes 101 below it, above 90.
  const r = anchoredRange(mk([...A,
    [108, 105, 107], [110, 106, 109], [111, 107, 110], [109, 100, 101],
  ]), 101, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.status, 'in_zone');
});

test('a new with-trend BOS re-anchors to the new leg origin', () => {
  // Swing high 120 at i11 known from i15; i18 closes 122 above it.
  const r = anchoredRange(mk([...A,
    [112, 100, 102], [115, 101, 114], [119, 110, 118], [124, 117, 122],
  ]), 122, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 100);
  assert.equal(r.extreme, 124);
  assert.equal(r.bosAgeBars, 0);
});

test('one close clearing two swing highs breaks both, so the protected low cannot slide back', () => {
  // Highs 110 (i3) and 108 (i9); lows 95 (i6) and 98 (i12). i15 closes 112,
  // above both. Without marking both, i16's close of 114 would "break" 110
  // again and re-anchor at 95.
  const B = [
    [101, 99, 100], [102, 100, 101], [103, 101, 102], [110, 102, 104],
    [106, 99, 100], [104, 97, 98], [101, 95, 97], [103, 96, 102],
    [105, 98, 104], [108, 101, 106], [106, 100, 101], [104, 99, 100],
    [102, 98, 99], [104, 99, 103], [107, 101, 106], [113, 105, 112],
    [115, 110, 114],
  ];
  const r = anchoredRange(mk(B), 114, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 98);
  assert.equal(r.bosAgeBars, 1);
});

// A pullback inside leg A that prints its own width-3 lower high (112 at i18,
// known from i22), then closes above it at i23 — still below the leg's HH 120.
const PULLBACK = [
  [108, 101, 102], [106, 99, 100], [107, 100, 106], [112, 104, 108],
  [109, 100, 101], [106, 97, 98], [104, 96, 100], [110, 99, 109], [114, 106, 113],
];

test('closing above a lower high inside the pullback does not re-anchor the leg', () => {
  const r = anchoredRange(mk([...A, ...PULLBACK]), 108, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.extreme, 120);
});

test('a deeper dip after that lower-high break stays an in-zone long, not broken', () => {
  const r = anchoredRange(mk([...A, ...PULLBACK, [112, 100, 101]]), 95, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.status, 'in_zone');
  close(r.pctOfRange, (95 - 90) / 30 * 100);
});

test('a close above the protected low after that lower-high break does not flip short', () => {
  const r = anchoredRange(mk([...A, ...PULLBACK, [112, 100, 101], [102, 93, 94]]), 94, OPTS);
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 90);
  assert.equal(r.status, 'in_zone');
});

test('the bar after a flip does not fire a fake break off old-trend swings', () => {
  // Internal low 104 (i14) sits above the flip close; it must not be a fresh
  // short-side target on the next bar.
  const r = anchoredRange(mk([...A,
    [108, 105, 107], [110, 106, 109], [111, 107, 110], [109, 100, 101],
    [100, 86, 87], [90, 84, 86],
  ]), 86, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 120);
  assert.equal(r.bosAgeBars, 1);
});

test('the old protected low is spent by the flip, so the next lower close is not a new break', () => {
  const r = anchoredRange(mk([...A, [106, 85, 87], [90, 84, 86]]), 86, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 120);
  assert.equal(r.bosAgeBars, 1);
});

test('the short side mirrors the long side', () => {
  const mirror = A.map(([h, l, c]) => [200 - l, 200 - h, 200 - c]);
  const r = anchoredRange(mk(mirror), 96, OPTS);
  assert.equal(r.side, 'short');
  assert.equal(r.protected, 110);
  assert.equal(r.extreme, 80);
  close(r.pctOfRange, (96 - 80) / 30 * 100);
  assert.equal(r.status, 'in_zone');
  close(r.distToProtectedPct, (110 / 96 - 1) * 100);
});

test('width 3 needs three lower bars on each side; width 2 does not', () => {
  const hs = [1, 2, 3, 9, 4, 5, 10, 1, 1, 1];
  const bars = hs.map((h) => ({ o: h, h, l: h - 1, c: h - 0.5 }));
  assert.deepEqual(swings(bars, 3).highs, [6]);
  assert.deepEqual(swings(bars, 2).highs, [3, 6]);
});

test('no break of structure in the window is unclear', () => {
  const flat = Array.from({ length: 25 }, () => [101, 99, 100]);
  assert.equal(anchoredRange(mk(flat), 100).status, 'unclear');
});

test('fewer than the default 20 bars is unclear', () => {
  assert.equal(ANCHORED.minBars, 20);
  assert.equal(anchoredRange(mk(A), 104).status, 'unclear');
});

test('a non-finite live price or a non-array input is unclear, not a throw', () => {
  assert.equal(anchoredRange(mk(A), NaN, OPTS).status, 'unclear');
  assert.equal(anchoredRange(null, 104, OPTS).status, 'unclear');
});

test('regression: BTC 4H ending 2026-10-07 02:42Z', () => {
  const raw = JSON.parse(readFileSync(
    new URL('./fixtures/btc-4h-2026-10-07.json', import.meta.url), 'utf8')).result.list;
  const bars = normalizeKlines(raw, INTERVAL_4H, Date.parse('2026-10-07T02:42:21Z'));
  const last = +raw[0][4]; // the forming bar's close is the live price
  const r = anchoredRange(bars, last);
  // The leg's HH is 87,383.6 (09-21); 10-02's 87,242.2 is a lower high inside
  // the pullback, so its break is internal and the anchor stays at 09-20's low.
  assert.equal(r.side, 'long');
  assert.equal(r.protected, 80092.3);
  assert.equal(r.extreme, 87383.6);
  assert.equal(r.pctOfRange.toFixed(1), '55.3');
  assert.equal(r.status, 'outside');
});

test('anchored and candidates are never referenced by the scoring engines', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    // Matched on import paths, not the bare word: absorption.js has its own,
    // unrelated "anchored" LTF read.
    assert.ok(!/['"][^'"]*\/(anchored|candidates)\.js['"]/.test(src),
      `${p} references the candidates pre-screen — it must never enter scoring`);
  }
});
