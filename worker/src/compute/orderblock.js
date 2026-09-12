/**
 * Order blocks — the last opposite-colored candle before an impulse leg out
 * of its own range. Bars are OLDEST-FIRST, same convention as fvg.js.
 *
 * PROVISIONAL, like absorption.js and regime.js: a reasoned heuristic, not a
 * playbook-specified layer, and it feeds no score — chart.js draws it as one
 * more POI alongside FVG, nothing more.
 *
 * An impulse at bar i is a CLOSE beyond the prior `lookback` bars' own
 * high/low. Bullish OB: the nearest bearish candle before an up-impulse.
 * Bearish OB: the nearest bullish candle before a down-impulse. Mitigated on
 * the same 50%-of-range rule fvg.js uses, so the two read consistently.
 */
function impulseDirection(bars, i, lookback) {
  const win = bars.slice(Math.max(0, i - lookback), i);
  if (!win.length) return 0;
  const hh = Math.max(...win.map((b) => b.h));
  const ll = Math.min(...win.map((b) => b.l));
  if (bars[i].c > hh) return 1;
  if (bars[i].c < ll) return -1;
  return 0;
}

/**
 * Scans from AFTER the impulse leg, not from right after the OB candle — the
 * impulse bar itself launches out of the OB's range by definition, and its
 * own wick dipping back through the midpoint is that launch, not a later
 * invalidation. Starting the scan at ob.index+1 would self-mitigate almost
 * every block the moment it forms.
 */
function isMitigated(ob, bars) {
  const mid = (ob.top + ob.bottom) / 2;
  for (let i = ob.impulseIndex + 1; i < bars.length; i++) {
    if (ob.type === 'bull' && bars[i].l <= mid) return true;
    if (ob.type === 'bear' && bars[i].h >= mid) return true;
  }
  return false;
}

export function findOrderBlocks(bars, lookback = 10) {
  const blocks = [];
  // A run of consecutive impulse bars all scan back to the SAME opposite
  // candle, so without this the one zone is emitted once per impulse — three
  // identical rectangles stacking their alpha into a darker box than any
  // other, and the label drawn three times on itself.
  const seen = new Set();
  for (let i = lookback; i < bars.length; i++) {
    const dir = impulseDirection(bars, i, lookback);
    if (!dir) continue;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      const b = bars[j];
      const isOpposite = dir > 0 ? b.c < b.o : b.c > b.o;
      if (!isOpposite) continue;
      const type = dir > 0 ? 'bull' : 'bear';
      const key = `${type}@${j}`;
      // Keep the FIRST impulse out of the zone — that is the displacement
      // that created it; later ones merely continue the move.
      if (!seen.has(key)) {
        seen.add(key);
        blocks.push({ type, index: j, impulseIndex: i, top: b.h, bottom: b.l });
      }
      break;
    }
  }
  for (const ob of blocks) ob.mitigated = isMitigated(ob, bars);
  return blocks;
}

/** Nearest unmitigated zone by distance from `price` to its closest edge. */
export function nearestZone(zones, price) {
  let best = null, bestDist = Infinity;
  for (const z of zones) {
    if (z.mitigated) continue;
    const edge = price > z.top ? z.top : price < z.bottom ? z.bottom : price;
    const dist = Math.abs((edge / price - 1) * 100);
    if (dist < bestDist) { bestDist = dist; best = z; }
  }
  return best ? { ...best, distPct: bestDist } : null;
}

/** Convenience wrapper, symmetric with fvg.js's nearestUnmitigatedFvg. */
export const nearestUnmitigatedOb = (bars, price, lookback = 10) =>
  nearestZone(findOrderBlocks(bars, lookback), price);
