/**
 * EMA + playbook §VII layer 4 ("EMA 34 alignment").
 *
 * The PRD specified limit=50 bars. EMA34 seeded from SMA(34) then has only 16
 * bars to converge, so the value still carries heavy seed bias and the layer
 * flips on noise. Callers must supply ~200 bars (~5x period).
 */

/** Standard EMA seeded with an SMA of the first `period` values. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * §VII layer 4. "Body close" = the close of the most recent CLOSED candle,
 * which is already guaranteed by normalizeKlines dropping the forming bar.
 * "Oscillating inside EMA" = the last `lookback` closes sit on both sides.
 */
export function emaAlignment(bars, period = 34, lookback = 3) {
  const closes = bars.map((b) => b.c);
  const series = ema(closes, period);
  const last = series.length - 1;
  if (last < 0 || series[last] == null) return { ema: null, close: null, side: 0 };

  let above = false, below = false;
  for (let i = Math.max(0, last - lookback + 1); i <= last; i++) {
    if (series[i] == null) continue;
    if (closes[i] > series[i]) above = true;
    if (closes[i] < series[i]) below = true;
  }

  const side = above && below ? 0 : Math.sign(closes[last] - series[last]);
  return { ema: series[last], close: closes[last], side };
}
