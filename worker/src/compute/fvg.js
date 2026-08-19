/**
 * Fair Value Gaps over a 3-candle window. Bars are OLDEST-FIRST.
 *
 * !! The PRD had these inverted. With oldest-first bars index i-2 is the OLDER
 * candle, so:
 *     bullish (gap up):   high[i-2] < low[i]     gap = [high[i-2], low[i]]
 *     bearish (gap down): low[i-2]  > high[i]    gap = [high[i],   low[i-2]]
 * Swapping them points every FVG on the dashboard the wrong way, which is why
 * fvg.test.js opens with two explicit regression tests.
 */

/** A gap is mitigated once a later candle trades through >= 50% of its height. */
function isMitigated(gap, bars) {
  const mid = (gap.top + gap.bottom) / 2;
  for (let i = gap.index + 1; i < bars.length; i++) {
    if (gap.type === 'bull' && bars[i].l <= mid) return true;
    if (gap.type === 'bear' && bars[i].h >= mid) return true;
  }
  return false;
}

export function findFvgs(bars) {
  const gaps = [];
  for (let i = 2; i < bars.length; i++) {
    const older = bars[i - 2], newer = bars[i];
    if (older.h < newer.l) {
      gaps.push({ type: 'bull', bottom: older.h, top: newer.l, index: i });
    } else if (older.l > newer.h) {
      gaps.push({ type: 'bear', bottom: newer.h, top: older.l, index: i });
    }
  }
  for (const g of gaps) g.mitigated = isMitigated(g, bars);
  return gaps;
}

/** Nearest unmitigated gap by distance from `price` to its closest edge. */
export function nearestUnmitigatedFvg(bars, price) {
  let best = null, bestDist = Infinity;
  for (const g of findFvgs(bars)) {
    if (g.mitigated) continue;
    const edge = price > g.top ? g.top : price < g.bottom ? g.bottom : price;
    const dist = Math.abs((edge / price - 1) * 100);
    if (dist < bestDist) { bestDist = dist; best = g; }
  }
  return best ? { ...best, distPct: bestDist } : null;
}
