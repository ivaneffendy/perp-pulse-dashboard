/**
 * Kline normalization — the single place venue quirks are absorbed.
 *
 * Bybit returns rows NEWEST-FIRST as string tuples:
 *   [startTime, open, high, low, close, volume, turnover]
 * Every compute module downstream assumes OLDEST-FIRST numeric bars, so if this
 * is wrong every derived signal is silently wrong with it.
 */

export const INTERVAL_15M = 15 * 60 * 1000;
export const INTERVAL_1H = 60 * 60 * 1000;
export const INTERVAL_4H = 4 * 60 * 60 * 1000;
export const INTERVAL_1D = 24 * 60 * 60 * 1000;

/**
 * @param {any[]} list            raw venue rows
 * @param {number} intervalMs     bar width, used to detect the forming candle
 * @param {number} now            caller-supplied clock (keeps this pure)
 * @param {boolean} dropUnclosed  false only for the daily pair, where PDH/PDL
 *                                needs TODAY's still-forming candle
 */
export function normalizeKlines(list, intervalMs, now, dropUnclosed = true) {
  if (!Array.isArray(list)) return [];
  const bars = list
    .map((r) => ({
      t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t);

  // The forming candle's close/high/low keep changing; including it makes every
  // signal flicker between refreshes.
  if (dropUnclosed) {
    while (bars.length && bars[bars.length - 1].t + intervalMs > now) bars.pop();
  }
  return bars;
}

/**
 * The most recently CLOSED bar's own open->close % return — the price move
 * across exactly the window a venue's hourly OI-history endpoint reports
 * (both round to the same clock-hour boundary). Distinct from a rolling
 * trailing-window change, which answers "how much has price moved in the
 * last N minutes ending now": this answers "how much did it move over the
 * same window OI is measured against", and the two drift up to a full bar
 * apart near the boundary. Returns null when there is no usable closed bar.
 */
export function lastClosedBarChangePct(bars) {
  const b = bars?.at(-1);
  return b && b.o ? (b.c / b.o - 1) * 100 : null;
}
