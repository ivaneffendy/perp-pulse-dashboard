/**
 * /candidates universe and ordering — pure, so index.js stays routing-only.
 * Spec: docs/superpowers/specs/2026-10-09-candidates-screener-design.md §2.
 */
export const CANDIDATES = { floor: 100_000_000, cap: 20, swingWidth: 3, bars: 200 };

/**
 * @param {{base:string, turnover24h:number}[]} tickers
 * @param {{floor:number, cap:number}} opts
 * @param {Set<string>|null} capBases  top-100-by-market-cap allowlist; null = unfiltered.
 *   Load-bearing: a turnover floor alone admits non-crypto Bybit listings (XAU, CL, SOXL).
 * @param {Set<string>} exclude  the no-trade list
 */
export function selectUniverse(tickers, opts, capBases, exclude) {
  if (!Array.isArray(tickers)) return [];
  return tickers
    .filter((t) => t.turnover24h >= opts.floor)
    .filter((t) => !capBases || capBases.has(t.base))
    .filter((t) => !exclude.has(t.base))
    .sort((a, b) => b.turnover24h - a.turnover24h)
    .slice(0, opts.cap);
}

const RANK = { in_zone: 0, outside: 1, broken: 2, unclear: 3, error: 4 };

/**
 * in_zone, then outside, each closest to 50% first; then broken, unclear and
 * error by turnover. Failures are listed, never dropped, so a missing coin
 * always means "below the criterion".
 */
export function sortCandidates(items) {
  return [...items].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r) return r;
    if (a.status === 'in_zone' || a.status === 'outside') {
      return Math.abs(a.pctOfRange - 50) - Math.abs(b.pctOfRange - 50);
    }
    return b.turnover24h - a.turnover24h;
  });
}
