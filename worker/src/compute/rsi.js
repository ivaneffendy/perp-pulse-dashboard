/**
 * 4H RSI — an EXTENSION read for the Extended tab and the chart-read snapshot,
 * never a score, never a signal.
 *
 * RSI measures momentum, not exhaustion: in a trend it sits above 70 or below
 * 30 for days. The Extended tab therefore always shows it beside the 4H trend
 * side, so "overbought" in an uptrend reads as "late, don't chase" and not as
 * "short here" (spec: docs/superpowers/specs/2026-11-18-extended-tab-design.md).
 *
 * Never imported by score.js, verdict.js, absorption.js or regime.js —
 * guarded by source inspection in test/rsi.test.js.
 */
export const RSI = { period: 14, ob: 70, os: 30, extremeOb: 80, extremeOs: 20 };

/**
 * Wilder's RSI of the LAST close. `closes` must be closed bars only, oldest
 * first: a forming bar would make the value move inside the 4H.
 * Seeded with the simple average of the first `period` changes, then Wilder
 * smoothing — the same construction TradingView's `ta.rsi` uses, so with
 * enough history the two agree to a decimal.
 *
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null} 0..100, or null with fewer than period + 1 closes
 */
export function rsi(closes, period = RSI.period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  if (!closes.every(Number.isFinite)) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * 'extreme_ob' ≥ 80 · 'ob' ≥ 70 · 'os' ≤ 30 · 'extreme_os' ≤ 20 · otherwise null.
 * @param {number|null|undefined} v
 */
export function rsiZone(v, t = RSI) {
  if (!Number.isFinite(v)) return null;
  if (v >= t.extremeOb) return 'extreme_ob';
  if (v >= t.ob) return 'ob';
  if (v <= t.extremeOs) return 'extreme_os';
  if (v <= t.os) return 'os';
  return null;
}
