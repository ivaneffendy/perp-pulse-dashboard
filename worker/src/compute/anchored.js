/**
 * Anchored 4H swing range — a PRE-SCREEN for /candidates, never a score.
 *
 * The range runs from the PROTECTED POINT to the LATEST EXTREME of the current
 * 4H leg (spec: docs/superpowers/specs/2026-10-09-candidates-screener-design.md
 * §1). Uptrend: from the swing low that produced the last body-close break of
 * structure up to the highest high since. It re-anchors only on a new
 * body-close break. Unlike equilibrium.js's rolling 30-bar window it never
 * follows price down a leg: a rolling window re-enters "discount" of each
 * lower range, which is the defect this exists to avoid.
 *
 * Never imported by score.js, verdict.js, absorption.js or regime.js —
 * guarded by source inspection in test/anchored.test.js.
 */
export const ANCHORED = { swingWidth: 3, minBars: 20 };

const UNCLEAR = Object.freeze({
  side: null, protected: null, extreme: null, pctOfRange: null,
  distToProtectedPct: null, bosAgeBars: null, status: 'unclear',
});

/**
 * Fractal swings: bar i is a swing high when its high is strictly above the
 * highs of the `w` bars on each side (lows mirrored). Strict, so a flat run of
 * equal bars produces no swing at all.
 */
export function swings(bars, w) {
  const highs = [], lows = [];
  for (let i = w; i < bars.length - w; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= w; k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h > bars[i + k].h)) isH = false;
      if (!(bars[i].l < bars[i - k].l && bars[i].l < bars[i + k].l)) isL = false;
    }
    if (isH) highs.push(i);
    if (isL) lows.push(i);
  }
  return { highs, lows };
}

const lowestIdx = (bars, a, b) => {
  let p = a;
  for (let k = a + 1; k <= b; k++) if (bars[k].l < bars[p].l) p = k;
  return p;
};
const highestIdx = (bars, a, b) => {
  let p = a;
  for (let k = a + 1; k <= b; k++) if (bars[k].h > bars[p].h) p = k;
  return p;
};

/** The most extreme swing index after `from` by `better`, or undefined. */
const extremeSince = (idx, from, better) => {
  let p;
  for (const x of idx) if (x > from && (p === undefined || better(x, p))) p = x;
  return p;
};

/**
 * One pass over closed bars. Returns `{ side, prot, bos }` (prot and bos are
 * bar indices) after the last bar, or null if no break ever printed.
 *
 * Two kinds of break, and only two:
 * - with-trend: a body close beyond the most recent known, unbroken swing in
 *   the trend's direction (either direction while no side is set yet);
 * - the flip: a body close through the protected point. A close below an
 *   internal swing low that sits above the protected low is NOT a break —
 *   that is the pullback being screened for.
 */
function structure(bars, w) {
  const { highs, lows } = swings(bars, w);
  const brokenH = new Set(), brokenL = new Set();
  // A swing at j is only knowable once its w right-hand bars have closed.
  const known = (idx, broken, i) => idx.filter((j) => j + w < i && !broken.has(j));
  let st = null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    let ev = null;
    if (st?.side === 'long' && c < bars[st.prot].l) {
      // The flip close spends every old-trend low it cleared (the protected
      // low included); left unbroken, they fire a fake break on the next bar.
      for (const x of known(lows, brokenL, i)) if (bars[x].l > c) brokenL.add(x);
      ev = { side: 'short', from: st.prot };
    } else if (st?.side === 'short' && c > bars[st.prot].h) {
      for (const x of known(highs, brokenH, i)) if (bars[x].h < c) brokenH.add(x);
      ev = { side: 'long', from: st.prot };
    } else {
      if (st?.side !== 'short') {
        const kh = known(highs, brokenH, i);
        // In a trend the target is the leg's HH — the highest unbroken swing
        // since the protected low — never just the most recent one, which
        // inside a pullback is a lower high and would drag the anchor into
        // the pullback. With no side yet, the most recent swing bootstraps.
        const j = st ? extremeSince(kh, st.prot, (x, y) => bars[x].h > bars[y].h) : kh.at(-1);
        if (j != null && c > bars[j].h) {
          // Mark EVERY swing this close cleared, or the next bars "break"
          // older swings price already left behind and the protected low
          // slides back to an older leg.
          for (const x of kh) if (bars[x].h < c) brokenH.add(x);
          ev = { side: 'long', from: j };
        }
      }
      if (!ev && st?.side !== 'long') {
        const kl = known(lows, brokenL, i);
        const j = st ? extremeSince(kl, st.prot, (x, y) => bars[x].l < bars[y].l) : kl.at(-1);
        if (j != null && c < bars[j].l) {
          for (const x of kl) if (bars[x].l > c) brokenL.add(x);
          ev = { side: 'short', from: j };
        }
      }
    }
    if (ev) {
      st = {
        side: ev.side,
        bos: i,
        prot: ev.side === 'long' ? lowestIdx(bars, ev.from, i) : highestIdx(bars, ev.from, i),
      };
    }
  }
  return st;
}

/**
 * @param {{h:number,l:number,c:number}[]} bars  CLOSED 4H bars, oldest first
 * @param {number} last  live price (the ticker's last)
 * @param {{swingWidth?:number, minBars?:number}} opts
 */
export function anchoredRange(bars, last, opts = ANCHORED) {
  const { swingWidth: w, minBars } = { ...ANCHORED, ...opts };
  if (!Array.isArray(bars) || bars.length < minBars || !Number.isFinite(last)) return { ...UNCLEAR };
  const st = structure(bars, w);
  if (!st) return { ...UNCLEAR };

  const long = st.side === 'long';
  const prot = long ? bars[st.prot].l : bars[st.prot].h;
  let extreme = last;
  for (let k = st.bos; k < bars.length; k++) {
    extreme = long ? Math.max(extreme, bars[k].h) : Math.min(extreme, bars[k].l);
  }
  const lo = long ? prot : extreme;
  const hi = long ? extreme : prot;
  if (!(hi > lo)) return { ...UNCLEAR };

  const pctOfRange = ((last - lo) / (hi - lo)) * 100;
  const broken = long ? last <= prot : last >= prot;
  const inZone = long ? pctOfRange < 50 : pctOfRange > 50;
  return {
    side: st.side,
    protected: prot,
    extreme,
    pctOfRange,
    distToProtectedPct: (prot / last - 1) * 100,
    bosAgeBars: bars.length - 1 - st.bos,
    status: broken ? 'broken' : inZone ? 'in_zone' : 'outside',
  };
}
