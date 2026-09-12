/**
 * Cross-market movers — "what actually moved unusually today, even on a coin
 * nobody is watching?" This sits OUTSIDE the four-question framework in
 * CLAUDE.md (score.js / verdict.js / absorption.js / regime.js): it is never
 * scored and never per-asset, closer to how dominance is display-only.
 *
 * Ranked by relative strength vs BTC because that is the actual screening
 * method this feature was requested to replicate (mentors/kevin-sailly.md in
 * the trading-vault, via playbook/pending-revisions.md R7's addendum) — but
 * this module is awareness-only by design. See
 * docs/superpowers/specs/2026-09-06-movers-screener-design.md for why: R7
 * already measured the small-cap relative-strength TRADING pattern at
 * -13.79R on this trader's own journal. The test file for this module
 * enforces, by source inspection, that it is never imported by score.js,
 * verdict.js, absorption.js or regime.js.
 */
export const MOVERS = {
  floor: 10_000_000, // USD 24h turnover — provisional, untuned against data
  top: 8,
};

/**
 * @param {{base:string, pct24h:number, turnover24h:number}[]} tickers
 * @param {{floor:number, top:number}} opts
 * @param {Set<string>|null} capBases - when given, restricts the ranked
 *   universe to these bases (top-N by market cap, fetched client-side — see
 *   src/marketcap.js and CLAUDE.md's dominance note for why market-cap data
 *   is never fetched from the Worker itself). BTC is exempt since it is the
 *   baseline, not a candidate.
 * @returns {{base:string, pct24h:number, turnover24h:number, rel:number}[]}
 */
export function rankMovers(tickers, opts = MOVERS, capBases = null) {
  if (!Array.isArray(tickers)) return [];
  const btcPct = tickers.find((x) => x.base === 'BTC')?.pct24h ?? 0;
  return tickers
    .filter((x) => x.base !== 'BTC' && x.turnover24h >= opts.floor)
    .filter((x) => !capBases || capBases.has(x.base))
    .map((x) => ({ ...x, rel: x.pct24h - btcPct }))
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel))
    .slice(0, opts.top);
}
