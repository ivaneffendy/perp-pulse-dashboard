#!/usr/bin/env node
/**
 * One JSON snapshot of what the dashboard shows for a symbol, for a chart
 * read to record instead of a pasted screenshot.
 *
 *   node scripts/dash_snapshot.js --symbol BTC            # live snapshot
 *   node scripts/dash_snapshot.js --symbol BTC --side long # anchored §IV Step 2 read only
 *
 * It goes through the Worker exactly as the page does (/macro, /asset, /ltf,
 * /candles) and builds the liquidity line with the Chart tab's own builder,
 * so nothing here is a second implementation of anything. Market data only:
 * no trade figure ever passes through this script.
 *
 * Exit 0 with JSON on stdout. Exit 1 with the reason on stderr when /asset
 * fails -- without the verdict there is no snapshot worth recording. A
 * failure of any other endpoint degrades that one field to null and is
 * listed in `errors`.
 */
import { findLiquidity } from '../worker/src/compute/liquidity.js';
import { VALID_BASE } from '../worker/src/pairs.js';
import { liqLine } from '../src/liq-line.js';

export const DEFAULT_API = 'https://perp-pulse-data.perp-pulse-data.workers.dev';
const TIMEOUT_MS = 15000;
// Same as src/chart.js COMPUTE_BARS: the liquidity scan must see the history
// the Chart tab sees, or the line stops matching the screen.
const COMPUTE_BARS = 90;

async function get(fetchFn, api, path, search = {}) {
  const url = new URL(api);
  url.pathname = path;
  for (const [k, v] of Object.entries(search)) if (v != null) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctrl.signal });
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(`${path}: ${body.detail || body.error || `HTTP ${r.status}`}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ETF flow, mirroring src/main.js: /macro's BTC figure is relayed to /asset as
 * ?etf= for every pair, and the Worker scores it for BTC only -- anything
 * else gets it as a proxy that is always 0 (worker/src/score.js). The phone's
 * manual override lives in the phone's localStorage and is invisible here.
 */
function etfOf(symbol, macro) {
  if (symbol !== 'BTC') return { source: 'proxy', usd: macro?.etfBtc ?? null };
  if (macro?.etfBtc == null) return { source: 'unknown', usd: null };
  return { source: 'auto', usd: macro.etfBtc };
}

export async function snapshot(symbol, { api = DEFAULT_API, fetchFn = fetch, now = () => new Date() } = {}) {
  const errors = [];
  const soft = (p) => p.catch((e) => { errors.push(e.message); return null; });

  const macro = await soft(get(fetchFn, api, '/macro'));
  const etf = etfOf(symbol, macro);
  const asset = await get(fetchFn, api, '/asset', { symbol, etf: etf.usd ?? undefined });
  const [ltf, candles] = await Promise.all([
    soft(get(fetchFn, api, '/ltf', { symbol })),
    soft(get(fetchFn, api, '/candles', { symbol, limit: COMPUTE_BARS })),
  ]);

  let liq = null;
  if (candles?.bars?.length) {
    const price = candles.bars[candles.bars.length - 1].c;
    liq = liqLine(symbol, findLiquidity(candles.bars, price).pools);
  }
  const sig = asset.signals || {};
  const eq = sig.equilibrium;
  return {
    schema: 1,
    fetchedAt: now().toISOString(),
    symbol,
    source: asset.source,
    mark: asset.price?.mark ?? null,
    score: {
      total: asset.score.total,
      verdict: asset.score.verdict,
      layers: Object.fromEntries(asset.score.layers.map((l) => [l.key, l.value])),
    },
    etf,
    emaSide: sig.ema?.side ?? null,
    equilibrium: eq ? { hh: eq.hh, ll: eq.ll, eq: eq.eq, zone: eq.zone, pctOfRange: eq.pctOfRange } : null,
    mode: sig.mode ?? null,
    ltf: ltf ? { label: ltf.label, rvol: ltf.rvol, anchored: !!ltf.anchored } : null,
    liq,
    errors,
  };
}

/** §IV Step 2's actual question. Needs a side, so never fetched before Phase 1. */
export async function anchoredLtf(symbol, side, { api = DEFAULT_API, fetchFn = fetch, now = () => new Date() } = {}) {
  if (side !== 'long' && side !== 'short') throw new Error(`side must be long or short, got ${side}`);
  const r = await get(fetchFn, api, '/ltf', { symbol, side });
  return {
    schema: 1, fetchedAt: now().toISOString(), symbol, side,
    label: r.label, barsAgo: r.barsAgo ?? null, anchored: !!r.anchored,
  };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const symbol = (arg(argv, 'symbol') || '').toUpperCase();
  // Same guard as the page: never interpolate an arbitrary string into an
  // upstream URL.
  if (!VALID_BASE.test(symbol)) throw new Error(`invalid --symbol ${symbol}`);
  const opts = { api: arg(argv, 'api') || DEFAULT_API };
  const side = arg(argv, 'side');
  const out = side ? await anchoredLtf(symbol, side, opts) : await snapshot(symbol, opts);
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`dash_snapshot: ${e.message}\n`);
    process.exit(1);
  });
}
