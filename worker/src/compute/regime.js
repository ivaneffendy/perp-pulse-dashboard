/**
 * Volatility regime — "is the tape behaving abnormally right now?"
 *
 * This is the FOURTH separate question in this codebase, alongside score.js
 * (§VII bias), verdict.js (Phase 2 pullback health) and absorption.js (§IV
 * Step 2 trigger). Like those three it is rendered on its own and is NEVER
 * summed, averaged or folded into any of them. §VII assigns no volatility row,
 * and scoring one at full weight would repeat the proxied-ETF bug exactly.
 *
 * Why range-vs-its-own-history rather than a macro calendar: a 2026-09-05 study
 * of twelve months of BTC klines found that roughly 88% of the largest 2h moves
 * had no schedulable cause — the two largest of the year were a social-media
 * post and a liquidation cascade. A calendar cannot see those. Realized range
 * against its own trailing distribution sees all of them.
 *
 * COINCIDENT, NOT LEADING. It reports that the tape IS disturbed, never that it
 * is about to be. On the largest cascade in the study window it ranked in the
 * low 60s at the opening bar and only reached the top three hours later.
 */

/**
 * Provisional — reasoned, not fitted to outcomes. Tuning lives here alone, the
 * way THRESHOLDS does in score.js and ABSORPTION does in absorption.js.
 *
 * `lookback` is 180 because both venues serve 200 bars in a single call and the
 * fallback venue (OKX) caps `candles` at 300. That makes the baseline about 7.5
 * days, not 30: a SUSTAINED high-volatility regime renormalises within roughly a
 * week and this reads calm again. It detects transitions, not levels.
 */
export const REGIME = {
  lookback: 180, // trailing COMPLETE bars in the baseline
  minBars: 60,   // below this a percentile is too coarse to report
};

const nodata = (why) => ({
  pct: null, rangePct: null, samples: 0, barAgeMs: null,
  msg: `${why} — not enough history to rank this bar.`,
});

/** True range as a fraction of the bar's open. NaN when the open is unusable. */
const trueRange = (b) => (b.o > 0 ? (b.h - b.l) / b.o : NaN);

/**
 * @param {{t:number,o:number,h:number,l:number,c:number}[]} bars
 *        1H bars, OLDEST-FIRST, with the forming candle DROPPED. This is the
 *        opposite of absorption(), deliberately: absorption judges the bar
 *        happening right now, regime ranks the last bar that actually closed.
 *        A forming bar's range is partial and would read calm at exactly the
 *        moment the tape went violent.
 * @param {{now:number, intervalMs:number, cfg?:object}} opts
 */
export function regime(bars, { now, intervalMs, cfg = REGIME } = {}) {
  if (!Array.isArray(bars) || bars.length < cfg.minBars + 1) {
    return nodata(`Only ${bars?.length ?? 0} bars available`);
  }

  const cur = bars[bars.length - 1];
  const r = trueRange(cur);
  if (!Number.isFinite(r)) return nodata('Current bar has no usable open');

  // The baseline is strictly BEFORE the judged bar. Folding a violent bar into
  // its own average dilutes it — the same rule absorption() documents.
  const lookback = Math.min(cfg.lookback, bars.length - 1);
  const prior = bars
    .slice(bars.length - 1 - lookback, bars.length - 1)
    .map(trueRange)
    .filter(Number.isFinite);

  if (prior.length < cfg.minBars) {
    return nodata(`Only ${prior.length} usable baseline bars`);
  }

  let below = 0;
  for (const x of prior) if (x < r) below += 1;

  return {
    pct: (below / prior.length) * 100,
    rangePct: r * 100,
    samples: prior.length,
    barAgeMs: now - (cur.t + intervalMs),
  };
}
