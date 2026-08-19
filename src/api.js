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
 */
export async function fetchMatrix(watchlist, opts, onRow) {
  await Promise.all(watchlist.map(async (base) => {
    try {
      onRow(base, { ok: true, data: await fetchAsset(base, opts) });
    } catch (e) {
      onRow(base, { ok: false, err: e.message });
    }
  }));
}
