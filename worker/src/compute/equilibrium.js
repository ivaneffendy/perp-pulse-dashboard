/**
 * Playbook §VIII / PRD §4A — the valuation engine.
 * Longs are only valid in Discount (<50%), shorts only in Premium (>50%),
 * so this also feeds §III pillar 2 when that milestone lands.
 */
export function equilibrium(bars, price, lookback = 30) {
  const win = bars.slice(-lookback);
  if (!win.length) return null;

  let hh = -Infinity, ll = Infinity;
  for (const b of win) {
    if (b.h > hh) hh = b.h;
    if (b.l < ll) ll = b.l;
  }
  const eq = (hh + ll) / 2;
  const range = hh - ll;

  return {
    hh, ll, eq,
    zone: price < eq ? 'DISCOUNT' : price > eq ? 'PREMIUM' : 'EQ',
    pctToLow: (price / ll - 1) * 100,
    pctToHigh: (hh / price - 1) * 100,
    pctOfRange: range > 0 ? ((price - ll) / range) * 100 : 50,
  };
}
