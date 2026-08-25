/**
 * Playbook §IV Step 2 — "Volume Verification (Effort vs Result)", marked
 * CRITICAL, and the one entry confirmation the dashboard could never derive.
 *
 *   Absorption (valid):   a wick sweep on a high volume spike — aggressive
 *                         takers absorbed by resting institutional limits.
 *   Initiative (invalid): the level breaks with strong bodies and high volume
 *                         and no rejection wick. A real breakout. Cancel.
 *
 * This is Phase 2 only. It NEVER enters score.js (§VII has no volume row) and
 * is never merged into verdict.js, which answers a 1-hour positioning question
 * from funding/OI/taker/book. Same discipline as score.js vs verdict.js: three
 * separate questions, rendered separately, never summed.
 */

/**
 * Provisional — reasoned, not fitted to history. Tuning lives here alone, the
 * way THRESHOLDS does in score.js.
 *
 * `wickDom + bodyDom > 1` is load-bearing, not incidental: since
 * upperWick + body + lowerWick === range, thresholds summing above 1 make
 * "dominant wick" and "dominant body" mutually exclusive by construction, so no
 * bar can be both and no tie-break rule is needed. A test guards the invariant.
 */
export const ABSORPTION = {
  lookback: 20,     // bars in the trailing volume baseline
  evalBars: 3,      // most recent bars considered (~45 min of 15m bars)
  rvolHot: 1.8,     // "high volume spike", relative to the baseline
  wickDom: 0.55,    // rejection wick's share of the bar's range
  bodyDom: 0.60,    // body's share of the range (initiative)
  minElapsed: 0.15, // floor on a forming bar's elapsed fraction
};

const nodata = (why) => ({
  cls: 'nodata', side: 0, rvol: null, label: 'No read',
  msg: `${why} — §IV Step 2 needs volume history this market has not supplied.`,
  bar: null,
});

/**
 * @param {{t:number,o:number,h:number,l:number,c:number,v:number}[]} bars
 *        15m bars, OLDEST-FIRST, with the forming candle KEPT. Like the daily
 *        sweep candle and unlike every other series here: the tap being judged
 *        is happening right now, so dropping the in-progress bar would hide the
 *        very thing this was called to see.
 * @param {{now:number,intervalMs:number,cfg?:object}} opts
 */
export function absorption(bars, { now, intervalMs, cfg = ABSORPTION } = {}) {
  if (!Array.isArray(bars) || bars.length < cfg.lookback + 1) {
    return nodata(`Only ${bars?.length ?? 0} bars available`);
  }

  // Evaluate the most recent bars that still have a COMPLETE baseline behind
  // them, rather than failing outright on a market with a short history.
  const last = bars.length - 1;
  const oldest = Math.max(cfg.lookback, bars.length - cfg.evalBars);

  let best = null;
  for (let i = oldest; i <= last; i++) {
    const b = bars[i];

    // The baseline is strictly BEFORE this bar. A spike folded into its own
    // average dilutes itself — the more violent the bar, the tamer it reads.
    let sum = 0;
    for (let k = i - cfg.lookback; k < i; k++) sum += bars[k].v;
    const avg = sum / cfg.lookback;
    if (!(avg > 0)) continue;

    // Only the last bar can still be forming, and its volume is partial: three
    // minutes into a 15m bar holds ~20% of a normal bar, which would read
    // "quiet" at exactly the moment the button was pressed.
    const forming = i === last && b.t + intervalMs > now;
    const elapsed = forming
      ? Math.min(1, Math.max(cfg.minElapsed, (now - b.t) / intervalMs))
      : 1;
    const rvol = b.v / (avg * elapsed);

    const range = b.h - b.l;
    if (!(range > 0)) continue; // a flat bar has no geometry to read

    const body = Math.abs(b.c - b.o);
    const upper = b.h - Math.max(b.o, b.c);
    const lower = Math.min(b.o, b.c) - b.l;

    let cls = 'quiet', side = 0;
    if (rvol >= cfg.rvolHot) {
      if (lower / range >= cfg.wickDom) { cls = 'absorbed'; side = 1; }
      else if (upper / range >= cfg.wickDom) { cls = 'absorbed'; side = -1; }
      else if (body / range >= cfg.bodyDom) { cls = 'initiative'; side = Math.sign(b.c - b.o); }
    }

    const cand = { cls, side, rvol, bar: { ...b, forming }, range, body, upper, lower };
    // Decisive readings outrank quiet ones; among equals, the heaviest wins.
    const rank = (x) => (x.cls === 'quiet' ? 0 : 1);
    if (!best || rank(cand) > rank(best) || (rank(cand) === rank(best) && cand.rvol > best.rvol)) {
      best = cand;
    }
  }

  if (!best) return nodata('No bar had both volume history and a readable range');
  return { ...describe(best), rvol: best.rvol, side: best.side, cls: best.cls, bar: best.bar };
}

function describe(x) {
  const mult = `${x.rvol.toFixed(1)}x`;
  const pct = (n) => `${Math.round((n / x.range) * 100)}%`;
  const when = x.bar.forming ? 'Forming 15m bar' : '15m bar';

  if (x.cls === 'absorbed' && x.side === 1) {
    return {
      label: 'Absorbed at the low',
      msg: `${when} on ${mult} average volume with a ${pct(x.lower)} lower wick, `
        + `closing back up — aggressive selling met resting bids. Reads as §IV Step 2 `
        + `absorption. Still needs the ChoCh and displacement FVG before it is an entry.`,
    };
  }
  if (x.cls === 'absorbed' && x.side === -1) {
    return {
      label: 'Absorbed at the high',
      msg: `${when} on ${mult} average volume with a ${pct(x.upper)} upper wick, `
        + `closing back down — aggressive buying met resting offers. Reads as §IV Step 2 `
        + `absorption. Still needs the ChoCh and displacement FVG before it is an entry.`,
    };
  }
  if (x.cls === 'initiative') {
    const dir = x.side > 0 ? 'up' : 'down';
    return {
      label: `Initiative ${dir} — not a sweep`,
      msg: `${when} on ${mult} average volume with a ${pct(x.body)} body and no `
        + `rejection wick — the level is being taken, not defended. §IV Step 2 calls this `
        + `initiative and invalidation: cancel the limit order rather than fading it.`,
    };
  }
  return {
    label: 'Quiet',
    msg: `${when} at ${mult} average volume — no spike worth reading. §IV Step 2 wants `
      + `a volume event to confirm either absorption or a real break; there is not one here.`,
  };
}
