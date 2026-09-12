/**
 * Top-100-by-market-cap allowlist for the Movers tab, fetched FROM THE
 * DEVICE — same reason as dominance in weather.js: every free market-cap API
 * rate-limits by IP, and Cloudflare's Worker egress IPs are shared across all
 * Workers customers, so the quota is gone before the Worker ever calls. The
 * browser has the user's own IP, so it just works.
 *
 * This is a NEW file rather than an export added to weather.js on purpose —
 * see CLAUDE.md's note on GitHub Pages' 10-minute cache: a stale cached
 * module missing a newly-added export is a SyntaxError that blanks the whole
 * page, but a new file can't be stale.
 *
 * The result is cached in localStorage because market-cap rank barely moves
 * day to day and this rides every manual Refresh press — re-asking CoinGecko
 * every time would burn through its anonymous rate limit for a ranking that
 * is still correct an hour later.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 4000;

async function jt(url, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function readCache() {
  try {
    const raw = localStorage.getItem('ppd_top100');
    const at = Number(localStorage.getItem('ppd_top100_at'));
    if (!raw || !Number.isFinite(at) || Date.now() - at > TTL_MS) return null;
    const bases = JSON.parse(raw);
    return Array.isArray(bases) && bases.length ? bases : null;
  } catch { return null; }
}

function writeCache(bases) {
  try {
    localStorage.setItem('ppd_top100', JSON.stringify(bases));
    localStorage.setItem('ppd_top100_at', String(Date.now()));
  } catch { /* private browsing / storage full — refetch next time */ }
}

/**
 * Returns a comma-joined string of up to 100 uppercase base tickers, or null
 * if no vendor answered and nothing usable is cached — in which case the
 * Movers tab falls back to its prior unfiltered (whole-market) behavior
 * rather than showing nothing, exactly like a failed dominance fetch falls
 * back to the Worker's own macro reading.
 */
export async function fetchTop100Bases() {
  const cached = readCache();
  if (cached) return cached.join(',');

  try {
    const rows = await jt(
      'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false',
    );
    const bases = rows?.map?.((r) => r?.symbol?.toUpperCase()).filter(Boolean);
    if (bases?.length) { writeCache(bases); return bases.join(','); }
  } catch { /* fall through to the backup vendor */ }

  try {
    const rows = await jt('https://api.coinpaprika.com/v1/tickers?limit=100');
    const bases = rows?.map?.((r) => r?.symbol?.toUpperCase()).filter(Boolean);
    if (bases?.length) { writeCache(bases); return bases.join(','); }
  } catch { /* both vendors unreachable */ }

  return null;
}
