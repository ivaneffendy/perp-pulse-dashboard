/**
 * Symbol allowlist. IDs are derivable from the base coin, but keeping an
 * explicit map both documents the supported set and stops arbitrary ?symbol=
 * strings being interpolated into upstream URLs.
 *
 * DEFAULT_WATCHLIST is playbook §II's fixed eight. The wider allowlist exists
 * because the trade journal shows real rotation (HYPE, WLD, RENDER, ZEC, ONDO)
 * that would otherwise need a redeploy to follow.
 *
 * UNVERIFIED: venue coverage for HYPE, WLD, RENDER, ZEC, ONDO, ASTER and JTO
 * has not been confirmed against Bybit/OKX. Check before relying on them; a
 * missing OKX instrument degrades to Bybit-only rather than failing.
 */
const mk = (base) => ({
  bybit: `${base}USDT`,
  okxInst: `${base}-USDT-SWAP`,
  okxCcy: base,
  binance: `${base}USDT`,
});

export const PAIRS = Object.fromEntries([
  // Playbook §II — anchors + beta basket
  'BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB',
  // Traded in the journal but not in §II
  'HYPE', 'WLD', 'RENDER', 'ZEC', 'ONDO', 'ASTER', 'JTO',
  // Previously supported majors
  'XRP', 'BNB', 'DOGE', 'ADA',
].map((b) => [b, mk(b)]));

export const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB'];

export function resolvePair(raw) {
  const base = String(raw || '').toUpperCase();
  return PAIRS[base] ? { base, ...PAIRS[base] } : { base: 'BTC', ...PAIRS.BTC };
}
