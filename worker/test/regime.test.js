import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { regime, REGIME } from '../src/compute/regime.js';

const H1 = 60 * 60 * 1000;

/** `n` calm bars, range 1.0 on an open of 100, i.e. 1% true range. */
const calm = (n, startT = 0) => Array.from({ length: n }, (_, i) => ({
  t: startT + i * H1, o: 100, h: 100.5, l: 99.5, c: 100,
}));

/** Appends `bar` after a full baseline; returns { bars, now } for a CLOSED bar. */
function withBaseline(bar, n = REGIME.lookback) {
  const bars = calm(n);
  const t = n * H1;
  bars.push({ ...bar, t });
  return { bars, now: t + H1 + 1 };
}

test('a wider-than-every-baseline-bar range ranks at the top', () => {
  const { bars, now } = withBaseline({ o: 100, h: 110, l: 90, c: 105 });
  const r = regime(bars, { now, intervalMs: H1 });
  assert.equal(r.pct, 100);
  assert.equal(Math.round(r.rangePct), 20);
  assert.equal(r.samples, REGIME.lookback);
});

test('a narrower-than-every-baseline-bar range ranks at the bottom', () => {
  const { bars, now } = withBaseline({ o: 100, h: 100.1, l: 99.9, c: 100 });
  const r = regime(bars, { now, intervalMs: H1 });
  assert.equal(r.pct, 0);
});

test('the judged bar is excluded from its own baseline', () => {
  // Every baseline bar is 1% and the judged bar is 1% too. If the judged bar
  // were folded into the baseline the count of strictly-smaller bars would
  // change; excluding it, nothing in the baseline is smaller, so pct is 0.
  const { bars, now } = withBaseline({ o: 100, h: 100.5, l: 99.5, c: 100 });
  const r = regime(bars, { now, intervalMs: H1 });
  assert.equal(r.pct, 0);
  assert.equal(r.samples, REGIME.lookback);
});

test('percentile is monotonic in the judged bar range', () => {
  const bars = calm(REGIME.lookback);
  // Give the baseline a spread so intermediate percentiles are reachable.
  bars.forEach((b, i) => { b.h = 100 + i * 0.01; b.l = 100 - i * 0.01; });
  const t = REGIME.lookback * H1;
  const at = (halfRange) => regime(
    [...bars, { t, o: 100, h: 100 + halfRange, l: 100 - halfRange, c: 100 }],
    { now: t + H1 + 1, intervalMs: H1 },
  ).pct;
  assert.ok(at(0.2) < at(0.9));
  assert.ok(at(0.9) < at(1.9));
});

test('too few bars returns the nodata shape rather than throwing', () => {
  const bars = calm(10);
  const r = regime(bars, { now: 10 * H1 + 1, intervalMs: H1 });
  assert.equal(r.pct, null);
  assert.equal(r.samples, 0);
  assert.match(r.msg, /bars available/);
});

test('a non-array input returns nodata rather than throwing', () => {
  const r = regime(null, { now: 0, intervalMs: H1 });
  assert.equal(r.pct, null);
});

test('an all-flat series does not divide by zero', () => {
  const bars = Array.from({ length: REGIME.lookback + 1 }, (_, i) => ({
    t: i * H1, o: 100, h: 100, l: 100, c: 100,
  }));
  const now = (REGIME.lookback + 1) * H1 + 1;
  const r = regime(bars, { now, intervalMs: H1 });
  assert.equal(r.pct, 0);
  assert.ok(Number.isFinite(r.rangePct));
});

test('a zero open is rejected rather than producing Infinity', () => {
  const { bars, now } = withBaseline({ o: 0, h: 1, l: 0, c: 1 });
  const r = regime(bars, { now, intervalMs: H1 });
  assert.equal(r.pct, null);
});

test('barAgeMs measures from the judged bar CLOSE, not its open', () => {
  const { bars, now } = withBaseline({ o: 100, h: 101, l: 99, c: 100 });
  const later = now + 20 * 60 * 1000;
  const r = regime(bars, { now: later, intervalMs: H1 });
  // close = t + intervalMs; now is 1ms + 20min past it.
  assert.equal(r.barAgeMs, 20 * 60 * 1000 + 1);
});

test('a caller that passes a FORMING bar is detectable, not silently wrong', () => {
  // regime() ranks whatever last bar it is given; dropping the forming candle
  // is the CALLER's job (both sources let normalizeKlines default to true).
  // A forming bar has not closed yet, so barAgeMs comes back negative — that
  // sign is the contract violation showing itself rather than hiding.
  const bars = calm(REGIME.lookback);
  const t = REGIME.lookback * H1;
  bars.push({ t, o: 100, h: 101, l: 99, c: 100 });
  const r = regime(bars, { now: t + 5 * 60 * 1000, intervalMs: H1 });
  assert.ok(r.barAgeMs < 0, 'a forming bar must surface as a negative age');
});

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/regime-golden.json', import.meta.url), 'utf8'),
);

/**
 * Pinned from real BTC 1H bars. These are calibration values, not arithmetic:
 * they change only if the ranking rule changes, which is exactly what this
 * guards. Percentiles are (bars strictly narrower / 180) * 100, so every value
 * is a multiple of 1/1.8 ≈ 0.5555.
 */
const EXPECTED = {
  'cascade following an unscheduled policy announcement, +3h': { pct: 100.0, rangePct: 11.476 },
  'deleveraging cascade': { pct: 97.8, rangePct: 3.428 },
  'mid-session expansion': { pct: 77.8, rangePct: 1.224 },
  'session-open expansion': { pct: 97.2, rangePct: 0.795 },
  'US session, ~3h after a tier-1 macro release': { pct: 94.4, rangePct: 1.149 },
};

test('golden fixture: every case has a full 181-bar window', () => {
  assert.equal(GOLDEN.length, 5);
  for (const g of GOLDEN) assert.equal(g.bars.length, REGIME.lookback + 1);
});

test('golden fixture: pinned percentiles reproduce', () => {
  for (const g of GOLDEN) {
    const now = g.judgedBarOpensAt + H1 + 1;
    const r = regime(g.bars, { now, intervalMs: H1 });
    const want = EXPECTED[g.label];
    assert.ok(want, `no pinned value for "${g.label}"`);
    assert.equal(Math.round(r.pct * 10) / 10, want.pct, `pct for ${g.label}`);
    assert.equal(Math.round(r.rangePct * 1000) / 1000, want.rangePct, `range for ${g.label}`);
  }
});

test('golden fixture: the display cut separates disturbed from ordinary tape', () => {
  const pcts = Object.fromEntries(
    GOLDEN.map((g) => [g.label, regime(g.bars, {
      now: g.judgedBarOpensAt + H1 + 1, intervalMs: H1,
    }).pct]),
  );
  const over = Object.values(pcts).filter((p) => p >= 90).length;
  // Four of the five real extremes clear the display cut; the fifth is a
  // deliberate negative — an ordinary expansion that must NOT light the chip.
  assert.equal(over, 4);
  assert.ok(pcts['mid-session expansion'] < 90);
});

test('regime is not referenced by any of the other three engines', () => {
  for (const p of ['../src/score.js', '../src/verdict.js', '../src/compute/absorption.js']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(
      !/regime/i.test(src),
      `${p} references regime — it is a separate question and must never be merged`,
    );
  }
});
