/**
 * Kline normalization — the single place venue quirks are absorbed.
 *
 * Bybit returns rows NEWEST-FIRST as string tuples:
 *   [startTime, open, high, low, close, volume, turnover]
 * Every compute module downstream assumes OLDEST-FIRST numeric bars, so if this
 * is wrong every derived signal is silently wrong with it.
 */

export const INTERVAL_15M = 15 * 60 * 1000;
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
