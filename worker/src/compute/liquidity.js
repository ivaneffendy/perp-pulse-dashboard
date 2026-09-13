import { sweepState } from './sweep.js';

/**
 * Resting liquidity pools — §III.1 Pillar 4/5 RAW MATERIAL, deliberately not
 * Pillar 4/5 itself.
 *
 * DISPLAY-ONLY, like orderblock.js and regime.js: it feeds no score, and
 * `liquidity.test.js` asserts by source inspection that score.js, verdict.js,
 * absorption.js, regime.js, movers.js and the Worker's index.js never mention
 * it.
 *
 * IT DELIBERATELY DOES NOT LABEL A POOL "INDUCEMENT" OR "DRAW TARGET". Which
 * one a pool is depends on the operator's SELECTED POI (§III.1 Pillar 3) and
 * intended direction, and this module knows neither -- it would have to guess
 * the POI. That guess is the exact defect pending-revisions R23 refuses to
 * close on Pillar 3, and R22 on Pillar 2: a display that reads as a pillar
 * while implementing something else. The Pillar 4/5 judgement belongs to the
 * chart-read adjudicator, which is handed the marked POI and the direction.
 *
 * So: this emits WHERE liquidity rests and WHETHER it is still there. Nothing
 * more.
 *
 * Three tiers, weakest evidence last:
 *   CLUSTER  equal highs/lows -- the one phrase in Pillar 4 that is literally
 *            mechanical. >= 2 fractals on the same side inside `tolPct`.
 *   FRACTAL  a lone swing high/low that clustered with nothing.
 *   PD       previous UTC day high/low -- Pillar 5's own first example.
 *
 * NOT implemented, and named as such in chart.js's legend rather than left to
 * be assumed: retail trendlines (subjective) and session highs/lows (4H bars
 * cannot resolve Asia/London/NY without a second, finer fetch).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 2-bar fractal, extracted so this module does not become a THIRD copy of
 * the same loop -- mode.js:12 and chart.js::findSwingsAndBos held it verbatim
 * twice already. chart.js now imports this one; `mode.js` keeps its own copy
 * on purpose, because it feeds the scored §VII TREND/RANGE read and a shared
 * refactor there could move a score silently.
 *
 * Indices come back in BARS space, not window space, so callers can index the
 * array they passed in.
 *
 * Minimum is 5 bars -- the true minimum for a 2-bar fractal. marketMode()'s
 * stricter >= 9 is about having room for a BOS, which is not this question.
 */
export function findSwings(bars, lookback = 30) {
  const win = bars.slice(-lookback);
  const winStart = bars.length - win.length;
  if (win.length < 5) return { highs: [], lows: [] };

  const highs = [], lows = [];
  for (let i = 2; i < win.length - 2; i++) {
    const { h, l } = win[i];
    if (h > win[i-1].h && h > win[i-2].h && h > win[i+1].h && h > win[i+2].h) highs.push({ i: i + winStart, p: h });
    if (l < win[i-1].l && l < win[i-2].l && l < win[i+1].l && l < win[i+2].l) lows.push({ i: i + winStart, p: l });
  }
  return { highs, lows };
}

/**
 * Greedy clustering over levels sorted ascending. Tolerance is measured
 * against the band itself, not against spot: two highs are "equal" or not by
 * their own spacing, and that answer must not change because price walked
 * away from them.
 */
function cluster(swings, tolPct) {
  const sorted = [...swings].sort((a, b) => a.p - b.p);
  const groups = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && ((s.p - g.top) / g.top) * 100 <= tolPct) {
      g.top = s.p;
      g.members.push(s);
    } else {
      groups.push({ top: s.p, bottom: s.p, members: [s] });
    }
  }
  return groups;
}

/**
 * Liquidity is taken by WICKS -- §IV Step 1's sweep is explicitly "a wick
 * only; the candle body closes back inside". So this reads h/l, never c.
 *
 * A band counts as swept only once price clears the WHOLE band: a wick into a
 * stack of equal highs has taken some of the stops sitting there, not the
 * pool. Scanning starts one bar after the last constituent fractal -- the two
 * bars that confirm a fractal are lower than it by definition and can never
 * sweep it.
 */
function sweptAfter(bars, fromIndex, side, level) {
  for (let i = fromIndex + 1; i < bars.length; i++) {
    if (side === 'high' && bars[i].h > level) return true;
    if (side === 'low' && bars[i].l < level) return true;
  }
  return false;
}

function pool(fields, price) {
  const offsetPct = (fields.level / price - 1) * 100;
  return { ...fields, offsetPct, distPct: Math.abs(offsetPct) };
}

function poolsFromSwings(bars, swings, side, price, tolPct) {
  return cluster(swings, tolPct).map((g) => {
    const level = side === 'high' ? g.top : g.bottom;
    const index = Math.max(...g.members.map((m) => m.i));
    return pool({
      tier: g.members.length > 1 ? 'CLUSTER' : 'FRACTAL',
      side,
      top: g.top,
      bottom: g.bottom,
      level,
      touches: g.members.length,
      index,
      swept: sweptAfter(bars, index, side, level),
      label: null,
    }, price);
  });
}

/**
 * PDH/PDL derived by aggregating the 4H bars into UTC days RATHER THAN
 * fetching OKX's daily candles, which roll at 16:00 UTC (UTC+8) -- the bug
 * commit 97e845a had to fix. Grouping here means the day boundary is ours and
 * cannot drift with a venue's local convention. It also costs no extra
 * request: the Chart tab already holds this history.
 *
 * The current day is intentionally PARTIAL -- sweepState() wants today's
 * still-forming extremes, because the sweep that matters is the one happening
 * now.
 */
function pdPools(bars, price) {
  if (!bars.length) return [];
  const byDay = new Map();
  for (const b of bars) {
    const k = Math.floor(b.t / DAY_MS);
    const d = byDay.get(k);
    if (d) { d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); }
    else byDay.set(k, { h: b.h, l: b.l });
  }
  const todayKey = Math.floor(bars[bars.length - 1].t / DAY_MS);
  const today = byDay.get(todayKey);
  const prevDay = byDay.get(todayKey - 1);
  if (!prevDay || !today) return [];

  // sweepState() owns the reclaimed/rejected reading -- §VII layer 5 already
  // defines it and a second opinion here would be a second definition.
  const { pdh, pdl, label } = sweepState(prevDay, today, price);
  return [
    pool({ tier: 'PD', side: 'high', top: pdh, bottom: pdh, level: pdh, touches: 1,
           index: null, swept: today.h > pdh, label }, price),
    pool({ tier: 'PD', side: 'low', top: pdl, bottom: pdl, level: pdl, touches: 1,
           index: null, swept: today.l < pdl, label }, price),
  ];
}

/**
 * `lookback` defaults to EVERYTHING HANDED IN, deliberately unlike
 * equilibrium()/marketMode(), which cap themselves at their own 30 bars. Those
 * answer "where are we in the recent range"; this answers "what is still
 * resting", and resting liquidity does not expire on a rolling window -- it
 * rests until it is taken. chart.js fetches 90 bars precisely so the zone
 * layers can see further back than the 30 it draws.
 *
 * @returns {{pools: object[]}} sorted nearest-first, so a caller capping the
 * drawing for a phone screen just slices. Swept pools ARE returned: whether a
 * raid already happened is information, and chart.js decides what to dim or
 * drop rather than having that choice made for it here.
 */
export function findLiquidity(bars, price, { tolPct = 0.15, lookback = bars.length } = {}) {
  const { highs, lows } = findSwings(bars, lookback);
  const pools = [
    ...poolsFromSwings(bars, highs, 'high', price, tolPct),
    ...poolsFromSwings(bars, lows, 'low', price, tolPct),
    ...pdPools(bars, price),
  ].sort((a, b) => a.distPct - b.distPct);
  return { pools };
}
