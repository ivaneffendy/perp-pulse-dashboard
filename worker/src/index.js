/**
 * Perp Pulse data Worker — routing only. All market logic lives in
 * compute/, sources/, score.js and verdict.js.
 *
 * Why this Worker exists (do not remove it): the browser cannot call the
 * exchanges directly. Binance futures/data/* sends no CORS headers, and
 * fapi is geo-blocked from Indonesia and from the Jakarta CF edge. The fetch
 * happens here instead, and this returns permissive CORS.
 */
import { resolvePair } from './pairs.js';
import { bybitCore, bybitDeep } from './sources/bybit.js';
import { okxExtras } from './sources/okx.js';
import { binanceExtras } from './sources/binance.js';
import { fetchMacro } from './sources/macro.js';
import { computeWalls } from './compute/walls.js';
import { emaAlignment } from './compute/ema.js';
import { equilibrium } from './compute/equilibrium.js';
import { nearestUnmitigatedFvg } from './compute/fvg.js';
import { sweepState } from './compute/sweep.js';
import { marketMode } from './compute/mode.js';
import { scoreAsset } from './score.js';
import { verdict } from './verdict.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});

/**
 * Cloudflare Workers send NO User-Agent by default, and CoinGecko hard-rejects
 * that with 403 "Please add a descriptive User-Agent to your request." The
 * failure was invisible because fetchMacro catches everything into nulls, so
 * the weather widget silently rendered em-dashes in production. Send a real UA
 * to every upstream.
 */
export const UPSTREAM_HEADERS = {
  'User-Agent': 'perp-pulse-dashboard (+https://github.com/ivaneffendy/perp-pulse-dashboard)',
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
};

/** Fetcher with an edge cache TTL, injected into every source module. */
const fetcher = (ttl) => async (url, { text = false } = {}) => {
  const r = await fetch(url, {
    headers: UPSTREAM_HEADERS,
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`${url.replace(/\?.*/, '')} -> ${r.status}`);
  return text ? r.text() : r.json();
};

async function attempt(fn) {
  try { return { ok: true, val: await fn() }; }
  catch (e) { return { ok: false, err: e.message }; }
}

/** Manual ETF override from the header toggle, when the feed is unreachable. */
function manualEtf(flag) {
  if (flag === 'in') return 60e6;
  if (flag === 'out') return -60e6;
  if (flag === 'flat') return 0;
  return undefined;
}

async function handleAsset(url) {
  const now = Date.now();
  const sym = resolvePair(url.searchParams.get('symbol') || 'BTC');
  const deep = url.searchParams.has('deep');
  const debug = url.searchParams.has('debug');
  const showBins = url.searchParams.has('bins');
  const skip = Promise.resolve({ ok: false, err: 'skipped' });

  const [core, macro, okx, bn, deepRes] = await Promise.all([
    attempt(() => bybitCore(sym, now, fetcher(30))),
    attempt(() => fetchMacro(fetcher(900))),
    deep ? attempt(() => okxExtras(sym, fetcher(15))) : skip,
    deep ? attempt(() => binanceExtras(sym, fetcher(15))) : skip,
    deep ? attempt(() => bybitDeep(sym, fetcher(15))) : skip,
  ]);

  if (!core.ok) {
    return json({ symbol: sym.base, error: 'Core source (Bybit) unreachable', detail: core.err }, 502);
  }

  const c = core.val;
  const m = macro.ok ? macro.val : {};

  // §VII layer 1: BTC uses BTC flow, ETH uses ETH flow, everything else is
  // proxied off BTC and tagged so the UI never presents it as asset-specific.
  const override = manualEtf(url.searchParams.get('etf'));
  const own = sym.base === 'BTC' ? m.etfBtc : sym.base === 'ETH' ? m.etfEth : null;
  const etfProxy = sym.base !== 'BTC' && sym.base !== 'ETH';
  const etfFlow = override !== undefined ? override : (etfProxy ? (m.etfBtc ?? null) : (own ?? null));

  const ema = emaAlignment(c.bars4h, 34);
  const eq = equilibrium(c.bars4h, c.mark, 30);
  const fvg = nearestUnmitigatedFvg(c.bars4h, c.mark);
  const sweep = sweepState(c.prevDay, c.today, c.mark);
  const mode = marketMode(c.bars4h);

  const score = scoreAsset({
    etfFlow, etfProxy, funding: c.funding,
    chg1h: c.chg1h, oiD1h: c.oiD1h, emaSide: ema.side, sweep,
  });

  const payload = {
    ts: now,
    symbol: sym.base,
    source: c.source,
    price: { mark: c.mark, chg1h: c.chg1h, chg24h: c.chg24h, chg4h: null },
    funding: { rate: c.funding, nextFundingTime: c.nextFundingTime },
    oi: { coin: c.oiCoin, usd: c.oiUsd, d1h: c.oiD1h, d4h: c.oiD4h },
    signals: {
      ema: { value: ema.ema, side: ema.side },
      equilibrium: eq,
      fvg,
      sweep,
      mode,
    },
    score,
  };

  if (deep) {
    const okv = okx.ok ? okx.val : null;
    const bnv = bn.ok ? bn.val : null;
    const dv = deepRes.ok ? deepRes.val : null;

    if (dv?.close4hAgo) payload.price.chg4h = (c.mark / dv.close4hAgo - 1) * 100;

    const venues = { bybit: c.oiCoin, okx: okv?.oiCoin ?? null, binance: bnv?.oiCoin ?? null };
    const agg = Object.values(venues).filter((v) => v != null).reduce((s, v) => s + v, 0);
    payload.oi.venues = venues;
    payload.oi.aggCoin = agg;
    payload.oi.aggUsd = agg * c.mark;

    const taker = bnv?.taker ?? okv?.taker ?? null;
    const topLS = bnv?.topLS ?? okv?.ls ?? dv?.accountLS ?? null;
    payload.positioning = {
      taker, topLS,
      source: bnv?.topLS != null ? 'Binance top-trader'
        : okv?.ls != null ? 'OKX accounts'
        : dv?.accountLS != null ? 'Bybit accounts' : 'n/a',
    };

    const book = okv?.book || (dv?.raw ? computeWalls(dv.raw.b, dv.raw.a) : null);
    if (book && !book.source) book.source = 'Bybit';
    if (book && !showBins) { delete book.bid.dbg; delete book.ask.dbg; }
    payload.book = book;

    // Phase 2 — a DIFFERENT question from score. Never merged with it.
    payload.health = verdict({
      chg1h: c.chg1h, oiD1h: c.oiD1h, funding: c.funding, taker, book,
    });
  }

  if (debug) {
    payload.diag = {
      bybit: 'ok',
      macro: macro.ok ? 'ok' : macro.err,
      okx: okx.ok ? 'ok' : okx.err,
      binance: bn.ok ? 'ok' : bn.err,
    };
  }
  return json(payload);
}

async function handleMacro() {
  const r = await attempt(() => fetchMacro(fetcher(900)));
  return json(r.ok ? { ts: Date.now(), ...r.val } : { ts: Date.now(), error: r.err });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/macro') return handleMacro();
    return handleAsset(url);
  },
};
