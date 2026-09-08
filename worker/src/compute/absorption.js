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
  anchorBars: 12,   // how far back an ANCHORED read may look (~3h of 15m bars)
  rvolHot: 1.8,     // "high volume spike", relative to the baseline
  wickDom: 0.55,    // rejection wick's share of the bar's range
  bodyDom: 0.60,    // body's share of the range (initiative)
  minElapsed: 0.15, // floor on a forming bar's elapsed fraction
};

const nodata = (why) => ({
  cls: 'nodata', side: 0, rvol: null, label: 'No read',
  msg: `${why} — §IV Step 2 needs volume history this market has not supplied.`,
  bar: null, anchored: false, barsAgo: null,
});

/**
 * Score ONE bar against its own trailing baseline. Returns null when the bar
 * cannot be read at all — no volume history behind it, or no range to measure.
 */
function judge(bars, i, last, cfg, now, intervalMs) {
  const b = bars[i];

  // The baseline is strictly BEFORE this bar. A spike folded into its own
  // average dilutes itself — the more violent the bar, the tamer it reads.
  let sum = 0;
  for (let k = i - cfg.lookback; k < i; k++) sum += bars[k].v;
  const avg = sum / cfg.lookback;
  if (!(avg > 0)) return null;

  // Only the last bar can still be forming, and its volume is partial: three
  // minutes into a 15m bar holds ~20% of a normal bar, which would read
  // "quiet" at exactly the moment the button was pressed.
  const forming = i === last && b.t + intervalMs > now;
  const elapsed = forming
    ? Math.min(1, Math.max(cfg.minElapsed, (now - b.t) / intervalMs))
    : 1;
  const rvol = b.v / (avg * elapsed);

  const range = b.h - b.l;
  if (!(range > 0)) return null; // a flat bar has no geometry to read

  const body = Math.abs(b.c - b.o);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;

  let cls = 'quiet', side = 0;
  if (rvol >= cfg.rvolHot) {
    if (lower / range >= cfg.wickDom) { cls = 'absorbed'; side = 1; }
    else if (upper / range >= cfg.wickDom) { cls = 'absorbed'; side = -1; }
    else if (body / range >= cfg.bodyDom) { cls = 'initiative'; side = Math.sign(b.c - b.o); }
  }
  return { cls, side, rvol, hot: rvol >= cfg.rvolHot,
           bar: { ...b, forming }, range, body, upper, lower, idx: i };
}

const emit = (x, { anchored, barsAgo, intervalMs }) => ({
  ...describe(x, { anchored, barsAgo, intervalMs }),
  rvol: x.rvol, side: x.side, cls: x.cls, bar: x.bar, anchored, barsAgo,
});

/**
 * @param {{t:number,o:number,h:number,l:number,c:number,v:number}[]} bars
 *        15m bars, OLDEST-FIRST, with the forming candle KEPT. Like the daily
 *        sweep candle and unlike every other series here: the tap being judged
 *        is happening right now, so dropping the in-progress bar would hide the
 *        very thing this was called to see.
 * @param {{now:number,intervalMs:number,cfg?:object,anchor?:'low'|'high'}} opts
 *        `anchor` switches from the LIVE read ("is there a volume event right
 *        now?") to the ANCHORED one ("was the sweep absorbed?"). See the
 *        anchoring note below the config block.
 */
export function absorption(bars, { now, intervalMs, cfg = ABSORPTION, anchor } = {}) {
  if (!Array.isArray(bars) || bars.length < cfg.lookback + 1) {
    return nodata(`Only ${bars?.length ?? 0} bars available`);
  }

  const last = bars.length - 1;

  // ANCHORED — judge the bar that made the extreme of the recent leg, which is
  // the sweep §IV Step 2 is actually asking about. Deliberately NOT "widen
  // evalBars": the existing rank prefers the loudest decisive bar, so a later,
  // louder, unrelated candle masks the sweep. Verified on BTC 2026-09-08, where
  // widening to 10 bars returned an `Initiative down` two bars past the low.
  if (anchor === 'low' || anchor === 'high') {
    const from = Math.max(cfg.lookback, bars.length - cfg.anchorBars);
    let pick = -1;
    for (let i = from; i <= last; i++) {
      if (pick < 0) { pick = i; continue; }
      pick = anchor === 'low'
        ? (bars[i].l < bars[pick].l ? i : pick)
        : (bars[i].h > bars[pick].h ? i : pick);
    }
    const x = pick < 0 ? null : judge(bars, pick, last, cfg, now, intervalMs);
    if (!x) return nodata('The extreme bar had no volume history or no readable range');
    return emit(x, { anchored: true, barsAgo: last - x.idx, intervalMs });
  }

  // LIVE — evaluate the most recent bars that still have a COMPLETE baseline
  // behind them, rather than failing outright on a market with a short history.
  const oldest = Math.max(cfg.lookback, bars.length - cfg.evalBars);

  let best = null;
  for (let i = oldest; i <= last; i++) {
    const cand = judge(bars, i, last, cfg, now, intervalMs);
    if (!cand) continue;
    // Decisive readings outrank quiet ones; among equals, the heaviest wins.
    const rank = (x) => (x.cls === 'quiet' ? 0 : 1);
    if (!best || rank(cand) > rank(best) || (rank(cand) === rank(best) && cand.rvol > best.rvol)) {
      best = cand;
    }
  }

  if (!best) return nodata('No bar had both volume history and a readable range');
  return emit(best, { anchored: false, barsAgo: last - best.idx, intervalMs });
}

/** Bars back -> readable elapsed time, e.g. 8 x 15m -> "2h". */
function ageText(barsAgo, intervalMs) {
  const mins = Math.round((barsAgo * intervalMs) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * An anchored read must never be readable as a live one. The payload carries
 * `anchored`/`barsAgo` for the UI, but the message is what gets read aloud and
 * pasted into the journal, so the age belongs in the prose too -- CLAUDE.md's
 * "a stale read is worse than none" is answered by naming the bar's age, not by
 * refusing to look back at all.
 */
function anchorNote(barsAgo, intervalMs) {
  return barsAgo
    ? ` Anchored read — this bar closed ${ageText(barsAgo, intervalMs)} ago and is the`
      + ` extreme of the anchor window, not the live tape.`
    : ' Anchored read — the extreme of the anchor window is the most recent bar.';
}

function describe(x, { anchored = false, barsAgo = 0, intervalMs = 0 } = {}) {
  const tail = anchored ? anchorNote(barsAgo, intervalMs) : '';
  const mult = `${x.rvol.toFixed(1)}x`;
  const pct = (n) => `${Math.round((n / x.range) * 100)}%`;
  const when = x.bar.forming ? 'Forming 15m bar' : '15m bar';

  if (x.cls === 'absorbed' && x.side === 1) {
    return {
      label: 'Absorbed at the low',
      msg: `${when} on ${mult} average volume with a ${pct(x.lower)} lower wick, `
        + `closing back up — aggressive selling met resting bids. Reads as §IV Step 2 `
        + `absorption. Still needs the ChoCh and displacement FVG before it is an entry.` + tail,
    };
  }
  if (x.cls === 'absorbed' && x.side === -1) {
    return {
      label: 'Absorbed at the high',
      msg: `${when} on ${mult} average volume with a ${pct(x.upper)} upper wick, `
        + `closing back down — aggressive buying met resting offers. Reads as §IV Step 2 `
        + `absorption. Still needs the ChoCh and displacement FVG before it is an entry.` + tail,
    };
  }
  if (x.cls === 'initiative') {
    const dir = x.side > 0 ? 'up' : 'down';
    return {
      label: `Initiative ${dir} — not a sweep`,
      msg: `${when} on ${mult} average volume with a ${pct(x.body)} body and no `
        + `rejection wick — the level is being taken, not defended. §IV Step 2 calls this `
        + `initiative and invalidation: cancel the limit order rather than fading it.` + tail,
    };
  }
  // A hot bar that matched no branch is NOT the same answer as a quiet one, and
  // anchoring makes the distinction routine: the extreme bar is chosen on price,
  // so it often carries real volume in a shape that qualifies as neither a
  // rejection nor a break. Reporting "no spike" there would hide the very
  // numbers needed to judge whether wickDom/bodyDom are set correctly -- and
  // those are self-described above as provisional and never fitted to history.
  if (x.hot) {
    const lead = x.lower >= x.upper ? `${pct(x.lower)} lower wick` : `${pct(x.upper)} upper wick`;
    return {
      label: 'Volume, but no clean shape',
      msg: `${when} on ${mult} average volume — the volume event is there, but the bar `
        + `is neither a rejection nor a clean break: ${lead} and a ${pct(x.body)} body, `
        + `matching no §IV Step 2 branch. Judge the chart, not this line.` + tail,
    };
  }
  return {
    label: 'Quiet',
    msg: `${when} at ${mult} average volume — no spike worth reading. §IV Step 2 wants `
      + `a volume event to confirm either absorption or a real break; there is not one here.` + tail,
  };
}
