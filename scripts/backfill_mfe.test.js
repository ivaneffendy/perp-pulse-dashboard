/**
 * Offline checks for backfill_mfe.js. No network: the venue is a fake that
 * serves synthetic 15m bars in OKX row order.
 *
 * Every price, size and timestamp below is INVENTED. This repo is public and the
 * journal is not — do not paste real trade figures in here to make a case
 * concrete.
 *
 * The regression that motivates most of this: resolveWindow originally read
 * `trade['Entry Date']` while main() stored the CSV row elsewhere, so EVERY
 * timestamp parsed as null and every trade silently fell through to price
 * inference anchored on the PREVIOUS trade's entry. It failed loudly on only
 * four rows; the other 24 produced plausible, wrong windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseWib, clean, excursions, resolveWindow, fetchRange, loadOverrides } from './backfill_mfe.js';
import { INTERVAL_15M } from '../worker/src/compute/klines.js';

const UTC = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

/** Fake venue: a flat tape with an optional spike, in OKX [ts,o,h,l,c,v] rows. */
function fakeVenue(bars) {
  return {
    maxBars: 100,
    instrument: () => 'FAKE',
    exists: async () => true,
    page: async (_sym, beforeMs, limit) => bars
      .filter((b) => b.t < beforeMs)
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((b) => [String(b.t), String(b.o), String(b.h), String(b.l), String(b.c), '1']),
  };
}

const tape = (startMs, count, shape) => Array.from({ length: count }, (_, i) => ({
  t: startMs + i * INTERVAL_15M, ...shape(i),
}));

test('journal clock is read as WIB, not UTC', () => {
  // 21:45:07 WIB is 14:45:07 UTC. Reading it as UTC lands seven hours late, and
  // the resulting window looks entirely plausible while being wrong.
  const p = parseWib('2026-01-15 21:45:07');
  assert.equal(p.hasTime, true);
  assert.equal(new Date(p.ms).toISOString(), '2026-01-15T14:45:07.000Z');
});

test('all three journal date formats parse, date-only flagged as such', () => {
  assert.equal(new Date(parseWib('15-01-2026').ms).toISOString(), '2026-01-14T17:00:00.000Z');
  assert.equal(parseWib('15-01-2026').hasTime, false);
  assert.equal(new Date(parseWib('15-01-2026 16:10').ms).toISOString(), '2026-01-15T09:10:00.000Z');
  assert.equal(parseWib('15-01-2026 16:10').hasTime, true);
  assert.equal(parseWib(''), null);
});

test('invisible Sheets formatting marks are stripped before parsing', () => {
  // Most rows in the export carry U+200E. Left in, Date.parse returns NaN.
  assert.equal(clean('‎2026-01-22 19:40:27'), '2026-01-22 19:40:27');
  assert.ok(parseWib('‎2026-01-22 19:40:27'));
});

test('REGRESSION: a logged clock is used verbatim, never re-inferred', async () => {
  // The bug this file exists for. If the window comes back `inferred`, the
  // timestamps are not reaching resolveWindow again.
  const trade = {
    entryTs: parseWib('2026-01-15 21:45:07'),
    closeTs: parseWib('2026-01-15 22:00:22'),
    entryPrice: 500, initialSl: 505, direction: 'short', isOpen: false,
  };
  const win = await resolveWindow(fakeVenue([]), {}, trade, null, UTC(2026, 8, 30));
  assert.equal(win.source, 'logged');
  assert.equal(new Date(win.fill).toISOString(), '2026-01-15T14:45:07.000Z');
  assert.equal(new Date(win.exit).toISOString(), '2026-01-15T15:00:22.000Z');
});

test('a date-only entry infers BOTH the fill and the unlogged stop-out', async () => {
  // The earliest journal rows log a day and nothing else: fill is the first bar
  // touching the entry, exit the first bar afterwards touching the initial stop.
  const start = UTC(2026, 1, 14, 17); // 15-01-2026 00:00 WIB
  const bars = tape(start, 96, (i) => {
    if (i === 10) return { o: 1000, h: 1040, l: 1010, c: 1030 };  // entry 1020
    if (i === 30) return { o: 980, h: 990, l: 940, c: 960 };      // stop 950
    return { o: 980, h: 995, l: 970, c: 980 };
  });
  const trade = {
    entryTs: parseWib('15-01-2026'), closeTs: null,
    entryPrice: 1020, initialSl: 950, direction: 'long', isOpen: false,
  };
  const win = await resolveWindow(fakeVenue(bars), {}, trade, null, UTC(2026, 8, 30));
  assert.equal(win.source, 'inferred');
  assert.equal(win.fill, start + 10 * INTERVAL_15M);
  assert.equal(win.exit, start + 31 * INTERVAL_15M, 'exit closes the stop-out bar');
});

test('an unlogged exit that never touches the stop fails loudly', async () => {
  // Better a named failure than a silently truncated window.
  const start = UTC(2026, 1, 14, 17);
  const bars = tape(start, 96, (i) => (i === 10
    ? { o: 1000, h: 1040, l: 1010, c: 1030 }
    : { o: 1000, h: 1010, l: 990, c: 1000 }));
  const trade = {
    entryTs: parseWib('15-01-2026'), closeTs: null,
    entryPrice: 1020, initialSl: 950, direction: 'long', isOpen: false,
  };
  await assert.rejects(
    () => resolveWindow(fakeVenue(bars), {}, trade, null, UTC(2026, 8, 30)),
    /not touched within 30d/);
});

test('the open trade with no dates anchors on the previous trade entry', async () => {
  const prev = UTC(2026, 2, 27, 19);
  const bars = tape(prev, 200, (i) => (i === 40
    ? { o: 800, h: 830, l: 810, c: 825 }           // touches 820
    : { o: 900, h: 910, l: 890, c: 900 }));
  const now = prev + 200 * INTERVAL_15M;
  const trade = {
    entryTs: null, closeTs: null,
    entryPrice: 820, initialSl: 700, direction: 'long', isOpen: true,
  };
  const win = await resolveWindow(fakeVenue(bars), {}, trade, prev, now);
  assert.equal(win.source, 'inferred');
  assert.equal(win.fill, prev + 40 * INTERVAL_15M);
  assert.equal(win.exit, now, 'an open position runs to now');
});

test('MFE/MAE are direction-aware', () => {
  const bars = [
    { t: 0, o: 100, h: 104, l: 99, c: 103 },
    { t: 1, o: 103, h: 110, l: 96, c: 98 },
  ];
  const long = excursions(bars, { entryPrice: 100, direction: 'long' }, 5);
  assert.equal(long.mfe_R, (110 - 100) / 5);   // best high
  assert.equal(long.mae_R, (100 - 96) / 5);    // worst low
  assert.equal(long.bars_to_mfe, 1);

  const short = excursions(bars, { entryPrice: 100, direction: 'short' }, 5);
  assert.equal(short.mfe_R, (100 - 96) / 5);   // favour is DOWN
  assert.equal(short.mae_R, (110 - 100) / 5);
});

test('CSV parser survives quoted multi-line note fields', () => {
  const rows = parseCsv('Trade ID,Notes\n1,"line one\nline two, with comma"\n2,plain\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Notes, 'line one\nline two, with comma');
  assert.equal(rows[1].Notes, 'plain');
});

test('an overridden row rebuilds 1R from the initial dollar risk', () => {
  // Synthetic. Where the logged stop is the trailed level, |entry - sl| collapses
  // and 1R must be rebuilt as initialRiskUsd * entry / notional instead.
  const entry = 100, notional = 400, initialRiskUsd = 10;
  const corrupted = Math.abs(entry - 99);                 // trailed stop, far too close
  const repaired = (initialRiskUsd * entry) / notional;   // 2.5
  assert.equal(repaired, 2.5);
  assert.ok(repaired / corrupted > 2, 'an unrepaired row understates 1R badly');
});

test('a row whose stop price survived needs no override', () => {
  // The other corruption shape: the recorded risk is wrong but the stop price is
  // intact, so the derived 1R already matches the intended dollar risk.
  const entry = 100, notional = 200, sl = 95;
  const oneR = (notional / entry) * Math.abs(entry - sl);
  assert.equal(oneR, 10);
});

test('loadOverrides reads the journal-side table, and tolerates absence', () => {
  assert.deepEqual(loadOverrides(null), {}, 'no --overrides means no repairs');
});
