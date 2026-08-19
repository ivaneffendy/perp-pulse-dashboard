const params = new URLSearchParams(location.search);
if (params.get('api')) localStorage.setItem('ppd_api', params.get('api'));

export const WORKER_URL = params.get('api')
  || localStorage.getItem('ppd_api')
  || 'https://perp-pulse-data.perp-pulse-data.workers.dev';

const TIMEOUT_MS = 8000;

async function get(path, search) {
  const url = new URL(WORKER_URL);
  url.pathname = path;
  for (const [k, v] of Object.entries(search)) if (v != null) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 429) throw new Error('rate limited — backing off');
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(body.detail || body.error || `HTTP ${r.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchAsset = (base, { deep = false, etf = null } = {}) =>
  get('/asset', { symbol: base, deep: deep ? 1 : null, etf });

export const fetchMacro = () => get('/macro', {});

/**
 * Fan out one request per asset. Deliberately NOT a single /matrix call: a
 * Worker invocation is capped at 50 subrequests, and one slow venue must not
 * blank the whole grid. Each row paints as it settles.
 *
 * CONCURRENCY IS CAPPED, and that cap is load-bearing. Firing all eight at once
 * made roughly three of them fail together: Bybit's CDN geo-blocks a share of
 * Cloudflare edge egress, and the burst was large enough that the OKX fallback
 * hit ITS rate limit at the same moment, so both venues were gone for the same
 * rows. A small pool spreads the burst over ~2s, which costs nothing visible
 * because rows paint progressively as they land.
 */
const POOL = 3;

export async function fetchMatrix(watchlist, opts, onRow) {
  const queue = [...watchlist];
  const run = async () => {
    while (queue.length) {
      const base = queue.shift();
      try {
        onRow(base, { ok: true, data: await fetchAsset(base, opts) });
      } catch (e) {
        onRow(base, { ok: false, err: e.message });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(POOL, watchlist.length) }, run),
  );
}
