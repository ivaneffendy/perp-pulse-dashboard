/**
 * Symbol resolution. IDs are mechanically derivable from the base coin, so
 * PAIRS is no longer a gate — it is the set whose venue coverage has actually
 * been VERIFIED. Anything else resolves too, flagged `known: false`.
 *
 * DEFAULT_WATCHLIST is playbook §II's fixed eight. The wider known set exists
 * because the trade journal shows real rotation (HYPE, WLD, RENDER, ZEC, ONDO).
 *
 * Venue coverage verified 2026-08-19: every base below exists on BOTH Bybit
 * linear (829 symbols) and OKX SWAP (452 instruments). A future listing that
 * OKX lacks degrades to Bybit-only rather than failing the row.
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

/**
 * What may be interpolated into an upstream URL. Deliberately narrow: no
 * separators, no punctuation, nothing that could add a query parameter or
 * traverse a path. Real tickers are alphanumeric and some lead with digits
 * (1000PEPE), so this admits every legitimate symbol and nothing else.
 */
export const VALID_BASE = /^[A-Z0-9]{2,15}$/;

/**
 * Returns null for anything the guard rejects — the caller answers 400.
 *
 * This replaces a silent fallback to BTC. That fallback was safe against
 * injection but produced a worse failure for a user-typed symbol: one coin's
 * numbers rendered under another coin's name. Refusing is the honest answer.
 */
export function resolvePair(raw) {
  const base = String(raw ?? '').trim().toUpperCase();
  if (!VALID_BASE.test(base)) return null;
  return { base, known: Object.hasOwn(PAIRS, base), ...mk(base) };
}
