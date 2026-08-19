/**
 * Order-book walls from a REST depth snapshot (single venue).
 *
 * The naive "heaviest bin wins" reports the SPREAD, not a wall: a BTC book is
 * densest at the touch, so the biggest bin is structurally the one next to mid
 * (that's why old output was +0.00% / -0.05%). Instead we use a band +
 * significance model, per side:
 *   - bin levels inside ±BAND% (clamped to what the snapshot actually covers)
 *   - DROP the innermost bin (that's the spread / top-of-book, always biggest)
 *   - a bin is a "wall" only if it's a real outlier: >= WALL_MULT x the median
 *     bin depth AND >= WALL_SHARE of that side's in-band volume
 *   - report the NEAREST qualifying wall (the gap) + the HEAVIEST (the magnet)
 * If nothing qualifies -> null (render "smooth"), never invent a near-mid wall.
 * `levels` = [priceStr, sizeStr, ...] (extra fields ignored). Bids desc, asks asc.
 */
const BAND = 0.005;       // ±0.5% target search window
const BIN_PCT = 0.0005;   // 0.05% price bins
const WALL_MULT = 3;      // >= 3x median bin depth (defines an outlier)
const WALL_SHARE = 0.06;  // >= 6% of that side's in-band volume (materiality floor)
const MIN_BINS = 4;       // need this many in-band bins before judging significance

function sideWalls(levels, mid, sign) {
  const binSize = mid * BIN_PCT; // price-relative; must NOT floor at 1 (breaks sub-$1 coins)
  const bins = new Map();
  let vol = 0, covered = 0;
  for (const lvl of levels) {
    const price = +lvl[0], qty = +lvl[1];
    if (!isFinite(price) || !isFinite(qty) || qty <= 0) continue;
    const dist = (price / mid - 1) * sign; // outward distance (>=0 on the correct side)
    if (dist < 0 || dist > BAND) continue;
    if (dist > covered) covered = dist;
    vol += qty;
    const key = Math.round(price / binSize) * binSize;
    bins.set(key, (bins.get(key) || 0) + qty);
  }
  const arr = [...bins.entries()]
    .map(([price, size]) => ({ price, size, distPct: (price / mid - 1) * 100 }))
    .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct)); // nearest first
  const cand = arr.slice(1); // drop innermost bin (the spread / top-of-book)
  let median = 0, threshold = 0, nearestWall = null, maxWall = null;
  if (cand.length) {
    const sizes = cand.map((c) => c.size).sort((a, b) => a - b);
    median = sizes[Math.floor(sizes.length / 2)] || 0;
    threshold = Math.max(WALL_MULT * median, WALL_SHARE * vol);
    if (arr.length >= MIN_BINS) {
      const q = cand.filter((c) => c.size >= threshold);
      if (q.length) {
        nearestWall = q[0]; // cand is nearest-first
        maxWall = q.reduce((m, c) => (c.size > m.size ? c : m), q[0]);
      }
    }
  }
  const fmt = (w) => (w ? { price: w.price, size: +w.size.toFixed(2), distPct: w.distPct } : null);
  return {
    nearestWall: fmt(nearestWall),
    maxWall: fmt(maxWall),
    vol,
    coveredPct: covered * 100,
    // Tuning aid, stripped from the response unless ?bins is present.
    dbg: {
      binCount: arr.length,
      median: +median.toFixed(4),
      threshold: +threshold.toFixed(4),
      top: cand.slice(0, 6).map((c) => ({ distPct: +c.distPct.toFixed(3), size: +c.size.toFixed(3) })),
    },
  };
}

export function computeWalls(bids, asks) {
  if (!bids || !asks || !bids.length || !asks.length) return null;
  const mid = (+bids[0][0] + +asks[0][0]) / 2;
  if (!isFinite(mid) || mid <= 0) return null;
  const bid = sideWalls(bids, mid, -1);
  const ask = sideWalls(asks, mid, +1);
  const total = bid.vol + ask.vol;
  return {
    mid,
    band: BAND * 100,
    bid,
    ask,
    imbalancePct: total ? (bid.vol / total) * 100 : 50,
  };
}
