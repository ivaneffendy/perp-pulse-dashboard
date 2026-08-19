// Base-coin amounts vary hugely across pairs (thousands of BTC vs billions of
// DOGE), and prices span 60000 to 0.38, so every formatter scales by magnitude.
export const fmtPct = (v, dp = 2) => (v >= 0 ? '+' : '') + v.toFixed(dp) + '%';

export const fmtPrice = (v) =>
  v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  : v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : v.toLocaleString('en-US', { maximumFractionDigits: 5 });

export const fmtCoin = (v) =>
  v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
  : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
  : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k'
  : v.toFixed(1);

export const fmtUsd = (v) =>
  Math.abs(v) >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T'
  : Math.abs(v) >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
  : '$' + (v / 1e6).toFixed(0) + 'M';

export const fmtScore = (n) => (n > 0 ? '+' : '') + n;
export const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

export function countdown(ts) {
  const s = Math.max(0, ts - Date.now());
  const h = Math.floor(s / 3.6e6), m = Math.floor((s % 3.6e6) / 6e4);
  return h + 'h ' + String(m).padStart(2, '0') + 'm';
}
