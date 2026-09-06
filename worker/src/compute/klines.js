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

/**
 * Aggregate 1H bars into daily bars bucketed by UTC calendar day — replacing
 * a dedicated daily-kline fetch. Every venue here already pulls ~200 hourly
 * bars for the volatility-regime baseline (regime.js), and 200 hours covers
 * today and yesterday many times over.
 *
 * `bars` MUST include the forming hour (normalizeKlines(..., dropUnclosed =
 * false)) — today's still-forming daily candle is exactly what the liquidity-
 * sweep check reads, and a forming hour's high/low can already be the day's
 * most extreme print.
 *
 * NOT used for OKX: OKX's own `bar=1D` candles bucket to UTC+8 (00:00
 * Singapore), not UTC midnight — confirmed 2026-09-06 by comparing OKX's daily
 * endpoint against this function's output on the same hourly bars. Deriving
 * OKX's daily bars this way would silently change what "today" means on an
 * OKX-served row versus what it means on a Bybit-served one, which is a
 * correctness question, not an efficiency one.
 */
export function dailyFromHourly(bars) {
  if (!Array.isArray(bars) || !bars.length) return { today: null, prevDay: null };
  const dayKey = (t) => Math.floor(t / INTERVAL_1D);
  const byDay = new Map();
  for (const b of bars) {
    const k = dayKey(b.t);
    const day = byDay.get(k);
    if (!day) byDay.set(k, { t: k * INTERVAL_1D, o: b.o, h: b.h, l: b.l, c: b.c });
    else { day.h = Math.max(day.h, b.h); day.l = Math.min(day.l, b.l); day.c = b.c; }
  }
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  return {
    today: keys.length ? byDay.get(keys.at(-1)) : null,
    prevDay: keys.length > 1 ? byDay.get(keys.at(-2)) : null,
  };
}
