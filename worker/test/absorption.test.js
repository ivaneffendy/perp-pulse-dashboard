import test from 'node:test';
import assert from 'node:assert/strict';
import { absorption, ABSORPTION } from '../src/compute/absorption.js';

const M15 = 15 * 60 * 1000;

/** Quiet baseline bars: small range, volume 100, all closed well before `now`. */
const baseline = (n, startT = 0) => Array.from({ length: n }, (_, i) => ({
  t: startT + i * M15, o: 100, h: 100.2, l: 99.8, c: 100, v: 100,
}));

/** Places `bar` after a full baseline and returns { bars, now } for a CLOSED bar. */
function withBaseline(bar, n = ABSORPTION.lookback) {
  const bars = baseline(n);
  const t = n * M15;
  bars.push({ ...bar, t });
  return { bars, now: t + M15 + 1 }; // past the close, so nothing is forming
}

test('high volume with a dominant lower wick is bullish absorption', () => {
  // range 10, lower wick 7 (70%), body 2 — swept down and closed back up.
  const { bars, now } = withBaseline({ o: 102, h: 105, l: 95, c: 104, v: 300 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.side, 1);
  assert.equal(Math.round(r.rvol * 100) / 100, 3);
});

test('high volume with a dominant upper wick is bearish absorption', () => {
  const { bars, now } = withBaseline({ o: 98, h: 105, l: 95, c: 96, v: 300 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.side, -1);
});

test('high volume with a dominant body up is initiative, not absorption', () => {
  // range 10, body 9 — a real break with no rejection.
  const { bars, now } = withBaseline({ o: 95.5, h: 105, l: 95, c: 104.5, v: 300 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'initiative');
  assert.equal(r.side, 1);
});

test('high volume with a dominant body down is bearish initiative', () => {
  const { bars, now } = withBaseline({ o: 104.5, h: 105, l: 95, c: 95.5, v: 300 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'initiative');
  assert.equal(r.side, -1);
});

test('high volume with an indecisive shape reads quiet', () => {
  // range 10: body 4, wicks 3 and 3 — nothing dominates.
  const { bars, now } = withBaseline({ o: 98, h: 105, l: 95, c: 102, v: 300 });
  assert.equal(absorption(bars, { now, intervalMs: M15 }).cls, 'quiet');
});

test('a big wick on ordinary volume is NOT absorption — volume gates the read', () => {
  const { bars, now } = withBaseline({ o: 102, h: 105, l: 95, c: 104, v: 100 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'quiet');
  assert.equal(r.side, 0);
});

test('the baseline excludes the bar being judged', () => {
  // A bar 20x the baseline must not dilute its own average: with 20 bars of
  // v=100 and this bar at v=2000, an inclusive mean would be ~190 (rvol ~10.5)
  // while the correct exclusive mean stays 100 (rvol 20).
  const { bars, now } = withBaseline({ o: 102, h: 105, l: 95, c: 104, v: 2000 });
  assert.equal(absorption(bars, { now, intervalMs: M15 }).rvol, 20);
});

test('a forming bar is pro-rated by elapsed time', () => {
  const bars = baseline(ABSORPTION.lookback);
  const t = ABSORPTION.lookback * M15;
  // Only 5 of 15 minutes elapsed, carrying 150 raw volume. Raw rvol would be
  // 1.5 (quiet); pro-rated against a third of a bar it is 4.5 (hot).
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 150 });
  const r = absorption(bars, { now: t + 5 * 60 * 1000, intervalMs: M15 });
  assert.equal(r.bar.forming, true);
  assert.equal(Math.round(r.rvol * 1e6) / 1e6, 4.5);
  assert.equal(r.cls, 'absorbed');
  // Without pro-rating the same bar would sit under the hot threshold.
  assert.ok(150 / 100 < ABSORPTION.rvolHot);
});

test('the minElapsed floor stops a seconds-old bar exploding the ratio', () => {
  const bars = baseline(ABSORPTION.lookback);
  const t = ABSORPTION.lookback * M15;
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 1 });
  const r = absorption(bars, { now: t + 1000, intervalMs: M15 }); // 1s in
  assert.ok(Number.isFinite(r.rvol));
  // Floored at minElapsed (0.15), not the true 0.0011 elapsed fraction.
  assert.equal(r.rvol, 1 / (100 * ABSORPTION.minElapsed));
});

test('the most decisive of several qualifying bars wins', () => {
  const bars = baseline(ABSORPTION.lookback);
  let t = ABSORPTION.lookback * M15;
  // Three qualifying absorption bars; the middle one is the heaviest.
  bars.push({ t: t,           o: 102, h: 105, l: 95, c: 104, v: 250 });
  bars.push({ t: t + M15,     o: 102, h: 105, l: 95, c: 104, v: 900 });
  bars.push({ t: t + 2 * M15, o: 102, h: 105, l: 95, c: 104, v: 300 });
  const r = absorption(bars, { now: t + 3 * M15 + 1, intervalMs: M15 });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.bar.v, 900);
});

test('only the last evalBars bars are considered', () => {
  const bars = baseline(ABSORPTION.lookback);
  let t = ABSORPTION.lookback * M15;
  // A monster absorption bar, then evalBars quiet bars burying it.
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 5000 });
  for (let i = 1; i <= ABSORPTION.evalBars; i++) {
    bars.push({ t: t + i * M15, o: 100, h: 100.2, l: 99.8, c: 100, v: 100 });
  }
  const r = absorption(bars, { now: t + (ABSORPTION.evalBars + 1) * M15 + 1, intervalMs: M15 });
  assert.equal(r.cls, 'quiet');
});

test('a zero-range bar is skipped, and readable neighbours still get read', () => {
  const bars = baseline(ABSORPTION.lookback);
  const t = ABSORPTION.lookback * M15;
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 300 });            // readable
  bars.push({ t: t + M15, o: 100, h: 100, l: 100, c: 100, v: 900 });  // zero range
  const r = absorption(bars, { now: t + 2 * M15 + 1, intervalMs: M15 });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.bar.v, 300);
  assert.ok(Number.isFinite(r.rvol));
});

test('a zero-range bar as the ONLY candidate reports nodata, not a false quiet', () => {
  // "Nothing happened" and "nothing could be read" are different answers, and
  // reporting the first when the second is true would understate the ignorance.
  const { bars, now } = withBaseline({ o: 100, h: 100, l: 100, c: 100, v: 900 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.equal(r.cls, 'nodata');
  assert.equal(r.rvol, null);
});

test('too few bars to build a baseline reports nodata', () => {
  const bars = baseline(5);
  const r = absorption(bars, { now: 6 * M15, intervalMs: M15 });
  assert.equal(r.cls, 'nodata');
  assert.equal(r.rvol, null);
});

test('a zero-volume baseline reports nodata rather than dividing by zero', () => {
  const bars = baseline(ABSORPTION.lookback).map((b) => ({ ...b, v: 0 }));
  const t = ABSORPTION.lookback * M15;
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 300 });
  const r = absorption(bars, { now: t + M15 + 1, intervalMs: M15 });
  assert.equal(r.cls, 'nodata');
});

test('empty input reports nodata', () => {
  assert.equal(absorption([], { now: 0, intervalMs: M15 }).cls, 'nodata');
});

test('wickDom and bodyDom cannot both be satisfied by one bar', () => {
  // upperWick + body + lowerWick === range always, so thresholds summing above
  // 1 make the two classifications mutually exclusive by construction. Tuning
  // that breaks this would silently reintroduce an ambiguous bar.
  assert.ok(ABSORPTION.wickDom + ABSORPTION.bodyDom > 1);
});

test('every result carries a human-readable label and message', () => {
  const { bars, now } = withBaseline({ o: 102, h: 105, l: 95, c: 104, v: 300 });
  const r = absorption(bars, { now, intervalMs: M15 });
  assert.ok(r.label.length > 0);
  assert.ok(r.msg.includes('§IV'));
});

// ---------------------------------------------------------------- anchoring
//
// §IV Step 2 asks "was the sweep that set up this trade absorbed?" — a fact
// about ONE bar that stays true. The live read answers "is there a volume
// event right now?", which decays. Both are legitimate; conflating them cost
// trade #30, where a correct `Absorbed at the low` at 07:18:49 had rolled to
// `Quiet` by the 08:25 fill, 66 minutes later — the time §IV Steps 3-5 take.
//
// Anchored reads are opt-in and must never masquerade as live: CLAUDE.md's
// "a stale read is worse than none" holds, and is answered by naming the bar
// and its age rather than by refusing to look back.

/** A sweep bar, then `gap` quiet bars burying it past the live window. */
function buriedSweep(sweep, gap) {
  const bars = baseline(ABSORPTION.lookback);
  const t = ABSORPTION.lookback * M15;
  bars.push({ ...sweep, t });
  for (let i = 1; i <= gap; i++) {
    bars.push({ t: t + i * M15, o: 100, h: 100.2, l: 99.8, c: 100, v: 100 });
  }
  return { bars, sweepT: t, now: t + (gap + 1) * M15 + 1 };
}

test('anchoring to the low reads a sweep the live window has rolled past', () => {
  const { bars, sweepT, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 }, 8);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'low' });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.side, 1);
  assert.equal(r.bar.t, sweepT);
});

test('anchoring to the high reads a bearish sweep the live window has rolled past', () => {
  const { bars, sweepT, now } = buriedSweep({ o: 98, h: 105, l: 95, c: 96, v: 300 }, 8);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'high' });
  assert.equal(r.cls, 'absorbed');
  assert.equal(r.side, -1);
  assert.equal(r.bar.t, sweepT);
});

test('an anchored read reports how many bars back the sweep was', () => {
  const { bars, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 }, 8);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'low' });
  assert.equal(r.barsAgo, 8);
});

test('an anchored read is flagged anchored so it cannot be read as live', () => {
  const { bars, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 }, 8);
  assert.equal(absorption(bars, { now, intervalMs: M15, anchor: 'low' }).anchored, true);
  assert.equal(absorption(bars, { now, intervalMs: M15 }).anchored, false);
});

test('anchoring picks the EXTREME bar, not the loudest one', () => {
  // The 2026-09-08 BTC shape, and the reason simply widening evalBars is wrong:
  // a later, louder, irrelevant bar outranks the sweep under rvol ordering.
  const bars = baseline(ABSORPTION.lookback);
  const t = ABSORPTION.lookback * M15;
  bars.push({ t, o: 102, h: 105, l: 95, c: 104, v: 300 });                  // extreme low 95
  bars.push({ t: t + M15, o: 101, h: 110, l: 99, c: 109.5, v: 5000 });      // louder, higher low
  for (let i = 2; i <= 6; i++) {
    bars.push({ t: t + i * M15, o: 100, h: 100.2, l: 99.8, c: 100, v: 100 });
  }
  const r = absorption(bars, { now: t + 7 * M15 + 1, intervalMs: M15, anchor: 'low' });
  assert.equal(r.bar.t, t);
  assert.equal(r.cls, 'absorbed');
});

test('the anchor never reaches further back than anchorBars', () => {
  // Beyond the window the sweep is gone for good — an anchored read is not a
  // licence to dredge up any old bar that suits the trade.
  const { bars, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 },
                                    ABSORPTION.anchorBars + 2);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'low' });
  assert.equal(r.cls, 'quiet');
});

test('omitting anchor leaves the live read unchanged', () => {
  // Guards the existing contract: CLAUDE.md defends the live read deliberately.
  const { bars, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 }, 8);
  assert.equal(absorption(bars, { now, intervalMs: M15 }).cls, 'quiet');
});

test('an anchored message states the bar age, so the prose cannot read as live', () => {
  // The payload carries `anchored`/`barsAgo` for the UI, but the message is what
  // gets read aloud and pasted into the journal. Without the age in the text,
  // an anchored read is indistinguishable from a live one — which is exactly the
  // "a stale read is worse than none" failure CLAUDE.md warns about.
  const { bars, now } = buriedSweep({ o: 102, h: 105, l: 95, c: 104, v: 300 }, 8);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'low' });
  assert.match(r.msg, /2h ago/);
});

test('the live message says nothing about age', () => {
  const { bars, now } = withBaseline({ o: 102, h: 105, l: 95, c: 104, v: 300 });
  assert.doesNotMatch(absorption(bars, { now, intervalMs: M15 }).msg, /ago/);
});

test('a hot bar failing the geometry is not described as "no spike worth reading"', () => {
  // The 2026-09-08 BTC sweep: 3.2x volume at the low, but a 48% lower wick
  // against wickDom 0.55. Volume was emphatically there; the SHAPE is what did
  // not qualify. Anchoring makes this common — the extreme bar is picked on
  // price, not volume — and calling it "no spike" hides the exact number needed
  // to judge whether the thresholds themselves are right.
  const { bars, now } = buriedSweep({ o: 101, h: 105, l: 95, c: 99, v: 300 }, 5);
  const r = absorption(bars, { now, intervalMs: M15, anchor: 'low' });
  assert.equal(r.cls, 'quiet');
  assert.doesNotMatch(r.msg, /no spike worth reading/);
  assert.match(r.msg, /3\.0x/);
});

test('a genuinely quiet bar still reads as no spike', () => {
  const { bars, now } = withBaseline({ o: 100, h: 105, l: 95, c: 101, v: 100 });
  assert.match(absorption(bars, { now, intervalMs: M15 }).msg, /no spike worth reading/);
});
