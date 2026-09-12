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
import { bybitCore, bybitDeep, bybitLtf, bybitTickers } from './sources/bybit.js';
import { okxExtras, okxCore, okxOpenInterest, okxLtf, okxTickers } from './sources/okx.js';
import { absorption } from './compute/absorption.js';
import { INTERVAL_15M, INTERVAL_1H, lastClosedBarChangePct } from './compute/klines.js';
import { binanceExtras } from './sources/binance.js';
import { fetchMacro } from './sources/macro.js';
import { computeWalls } from './compute/walls.js';
import { emaAlignment } from './compute/ema.js';
import { equilibrium } from './compute/equilibrium.js';
import { nearestUnmitigatedFvg } from './compute/fvg.js';
import { sweepState } from './compute/sweep.js';
import { marketMode } from './compute/mode.js';
import { regime } from './compute/regime.js';
import { rankMovers, MOVERS } from './compute/movers.js';
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

/**
 * Fetcher with an edge cache TTL, injected into every source module.
 *
 * THE CACHE KEY IS BUCKETED PER TTL WINDOW (`_ttl=<window>`), and that is not
 * cosmetic. Cloudflare's edge cache is keyed by URL and **shared across every
 * Workers customer**. With `cacheEverything`, a 403 that Bybit's CloudFront
 * returned to somebody else's Worker for a hot symbol gets stored under that
 * URL and replayed to us indefinitely. That is exactly what broke ETH while
 * BTC/SOL/SUI were fine: fetching the identical ETH URLs with no `cf` options
 * returned 200 every time.
 *
 * Setting `cacheTtlByStatus: {'400-599': 0}` does NOT fix it — that governs
 * what we WRITE to cache, not what we READ. Bucketing gives each TTL window its
 * own key, so a poisoned entry can survive at most one window and we never read
 * another customer's cached error.
 *
 * One retry on top: a 403/429 from a shared egress IP is transient, and a retry
 * costs one subrequest against a 50 budget we barely touch.
 */
const fetcher = (ttl) => async (url, { text = false, retry = true, bucket = true } = {}) => {
  // bucket:false for plain HTML pages (Farside): they are not APIs, so we do
  // not append query params they never expect. (Note: this was NOT the cause of
  // etfBtc reading 0 — that is Farside genuinely publishing 0.0 for the current
  // UTC day before the figure lands. 0 scores neutral, so it degrades safely.)
  const sep = url.includes('?') ? '&' : '?';
  const target = bucket ? `${url}${sep}_ttl=${Math.floor(Date.now() / (ttl * 1000))}` : url;
  const opts = {
    headers: UPSTREAM_HEADERS,
    cf: { cacheTtl: ttl, cacheEverything: true },
  };
  let r = await fetch(target, opts);
  // Bybit's CloudFront geo-blocks some Cloudflare edge egress intermittently,
  // and the page fires eight asset requests at once, which makes a hit far more
  // likely. Retry WITH BACKOFF — retrying instantly just re-races the same
  // congested moment, which is why zero-delay retries barely helped.
  const backoff = [120, 350, 800];
  for (let i = 0; i < backoff.length && !r.ok && retry; i++) {
    if (r.status !== 403 && r.status !== 429 && r.status < 500) break;
    await new Promise((res) => setTimeout(res, backoff[i]));
    r = await fetch(target, opts);
  }
  if (!r.ok) {
    // Include a snippet of the body: a bare status hides whether this is a rate
    // limit, a WAF block, or an unsupported symbol.
    let why = '';
    try { why = ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 180); } catch { /* consumed */ }
    throw new Error(`${url.replace(/\?.*/, '')} -> ${r.status}${why}`);
  }
  return text ? r.text() : r.json();
};

async function attempt(fn) {
  try { return { ok: true, val: await fn() }; }
  catch (e) { return { ok: false, err: e.message }; }
}

/**
 * Bybit-primary/OKX-fallback attempt, shared by every route that offers this
 * exact venue pair (handleLtf, handleMovers — NOT handleAsset, which has its
 * own differently-shaped fallback: `upstream` vs `detail`, plus "not listed"
 * branching and a `fellBack` flag the caller needs downstream). On double
 * failure, `err` names both venues so the 502 body is never ambiguous about
 * which upstream(s) failed.
 */
async function withFallback(bybitFn, okxFn) {
  let res = await attempt(bybitFn);
  if (res.ok) return res;
  const bybitErr = res.err;
  res = await attempt(okxFn);
  if (res.ok) return res;
  return { ok: false, err: `bybit: ${bybitErr} | okx: ${res.err}` };
}

/**
 * A rejected symbol is refused outright rather than substituted. Serving BTC's
 * numbers under a mistyped name is the one failure a user-typed symbol field
 * must never produce.
 */
const badSymbol = (url) => json({
  error: 'Invalid symbol',
  detail: `${JSON.stringify(url.searchParams.get('symbol'))} is not a valid base `
    + 'coin — expected 2-15 letters or digits, e.g. BTC or 1000PEPE.',
}, 400);

/**
 * ETF net flow for score layer 1, supplied by the CALLER as `?etf=`.
 *
 * /asset deliberately does NOT fetch macro itself: eight concurrent asset
 * requests all missing the macro cache at the same instant is a stampede, and
 * it blew CoinPaprika's 60-requests-per-hour limit (402). The page fetches
 * /macro once per refresh and relays the number here, so scoring still happens
 * server-side in exactly one place.
 *
 * Accepts a raw USD number, or the header toggle's in/out/flat.
 */
function etfFromParam(raw) {
  if (raw == null || raw === '') return undefined;
  if (raw === 'in') return 60e6;
  if (raw === 'out') return -60e6;
  if (raw === 'flat') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function handleAsset(url) {
  const now = Date.now();
  const sym = resolvePair(url.searchParams.get('symbol') || 'BTC');
  if (!sym) return badSymbol(url);
  const deep = url.searchParams.has('deep');
  const debug = url.searchParams.has('debug');
  const showBins = url.searchParams.has('bins');
  const skip = Promise.resolve({ ok: false, err: 'skipped' });

  const [core, okx, bn, deepRes] = await Promise.all([
    attempt(() => bybitCore(sym, now, fetcher(30))),
    deep ? attempt(() => okxExtras(sym, fetcher(15))) : skip,
    deep ? attempt(() => binanceExtras(sym, fetcher(15))) : skip,
    deep ? attempt(() => bybitDeep(sym, fetcher(15))) : skip,
  ]);

  // Bybit is primary; OKX takes over when Bybit's CDN geo-blocks this edge.
  let coreVal = core.ok ? core.val : null;
  let coreErr = core.ok ? null : core.err;
  let fellBack = false;
  if (!coreVal) {
    const alt = await attempt(() => okxCore(sym, now, fetcher(30)));
    if (alt.ok) { coreVal = alt.val; fellBack = true; }
    else {
      // A coin outside the verified set that no venue serves is almost always
      // simply not listed — not an outage. Saying "no core source reachable"
      // with a raw upstream TypeError attached is a developer's message shown
      // to someone who just mistyped a ticker. Keep the technical text, but
      // under a key the page does not surface: `detail` is what api.js prefers
      // and renders on the row, so it must never hold the raw upstream dump —
      // that stays under `upstream` alone, for `?debug=1` / network-tab use.
      const upstream = `bybit: ${coreErr} | okx: ${alt.err}`;
      const notListed = !sym.known;
      return json({
        symbol: sym.base,
        // No need to repeat the ticker — `symbol` is right there, and the page
        // renders this next to it.
        error: notListed ? 'Not listed on Bybit or OKX' : 'No core source reachable',
        upstream,
      }, 502);
    }
  }

  const c = coreVal;

  // Bybit's OI endpoint geo-fails often. Rather than lose score layer 3, patch
  // it from OKX, which answers reliably from this edge.
  let oiSource = fellBack ? 'OKX' : 'Bybit';
  if (c.oiMissing) {
    const oiAlt = await attempt(() => okxOpenInterest(sym, fetcher(30)));
    if (oiAlt.ok && oiAlt.val) {
      Object.assign(c, oiAlt.val);
      c.oiUsd = c.oiCoin * c.mark;
      oiSource = 'OKX (Bybit OI blocked)';
    } else {
      oiSource = 'unavailable';
    }
  }

  // §VII layer 1. The supplied flow is BTC's, so it is asset-specific only for
  // BTC and tagged `proxy` everywhere else. ETH has no free spot-ETF feed, so
  // it is proxied too rather than misreporting BTC flow as ETH flow.
  const supplied = etfFromParam(url.searchParams.get('etf'));
  const etfFlow = supplied === undefined ? null : supplied;
  const etfProxy = sym.base !== 'BTC';

  const ema = emaAlignment(c.bars4h, 34);
  const eq = equilibrium(c.bars4h, c.mark, 30);
  const fvg = nearestUnmitigatedFvg(c.bars4h, c.mark);
  const sweep = sweepState(c.prevDay, c.today, c.mark);
  const mode = marketMode(c.bars4h);

  // The FOURTH question — see CLAUDE.md. Deliberately NOT passed to scoreAsset
  // below, nor to verdict(), nor to absorption(): §VII has no volatility row.
  const reg = regime(c.bars1h, { now, intervalMs: INTERVAL_1H });

  // Layer 3 compares a price change to an OI change over the SAME window.
  // c.chg1h is a rolling trailing-60min figure — right for the live "1h%"
  // badge next to the price, and for verdict()'s right-now read below — but
  // oiD1h is bucketed to the venue's clock-hour boundary, so the two drift up
  // to ~55min apart near the top of the hour. Score off the last CLOSED 1H
  // bar's own return instead: it shares oiD1h's exact window. c.chg1h is left
  // untouched for display and verdict().
  const chg1hForScore = lastClosedBarChangePct(c.bars1h) ?? c.chg1h;

  const score = scoreAsset({
    etfFlow, etfProxy, funding: c.funding,
    chg1h: chg1hForScore, oiD1h: c.oiD1h, emaSide: ema.side, sweep,
  });

  const payload = {
    ts: now,
    symbol: sym.base,
    // false = venue coverage was never verified for this base. It resolved and
    // answered, but it is outside the checked set, so the UI says so.
    known: sym.known,
    source: c.source,
    price: { mark: c.mark, chg1h: c.chg1h, chg24h: c.chg24h, chg4h: null },
    funding: { rate: c.funding, nextFundingTime: c.nextFundingTime },
    oi: { coin: c.oiCoin, usd: c.oiUsd, d1h: c.oiD1h, d4h: c.oiD4h, source: oiSource },
    signals: {
      ema: { value: ema.ema, side: ema.side },
      equilibrium: eq,
      fvg,
      sweep,
      mode,
      regime: reg,
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
      bybit: core.ok ? 'ok' : coreErr,
      coreUsed: fellBack ? 'OKX (Bybit failed)' : 'Bybit',
      oiSource,
      etf: supplied === undefined ? 'not supplied by caller' : String(supplied),
      okx: okx.ok ? 'ok' : okx.err,
      binance: bn.ok ? 'ok' : bn.err,
    };
  }
  return json(payload);
}

async function handleMacro(url) {
  const r = await attempt(() => fetchMacro(fetcher(900)));
  if (!r.ok) return json({ ts: Date.now(), error: r.err });
  const { errors, ...rest } = r.val;
  // Upstream reasons only on ?debug=1 — the page never needs them.
  return json(url.searchParams.has('debug')
    ? { ts: Date.now(), ...rest, errors }
    : { ts: Date.now(), ...rest });
}

/**
 * Playbook §IV Step 2 — on demand only, never on a timer.
 *
 * A 15m absorption read is meaningful only in the minutes around the POI tap,
 * so joining the refresh loop would routinely serve a verdict computed BEFORE
 * the alert fired — worse than showing nothing, because it invites acting on a
 * stale read of the one thing that is supposed to be live.
 *
 * Deliberately NOT part of /asset: that path always fetches core first, so a
 * `?ltf=1` param would pay four upstream calls to obtain the one that matters.
 * Here a button press costs exactly one.
 */
export async function handleLtf(url) {
  const now = Date.now();
  const sym = resolvePair(url.searchParams.get('symbol') || 'BTC');
  if (!sym) return badSymbol(url);

  // `?side=` switches the question. Without it: "is there a volume event right
  // now?" — the live read, correct in the minutes around a tap. With it: "was
  // the sweep absorbed?", anchored to the extreme bar of the recent leg, which
  // is what §IV Step 2 actually asks and what stays true while Steps 3-5 play
  // out. An unknown value is refused rather than quietly answered as live:
  // returning a different question's answer under the caller's own parameter is
  // the same silent substitution `badSymbol` exists to prevent.
  const rawSide = url.searchParams.get('side');
  const anchor = { long: 'low', short: 'high' }[rawSide ?? ''];
  if (rawSide != null && !anchor) {
    return json({
      error: 'Invalid side',
      detail: `${JSON.stringify(rawSide)} is not a valid side — expected "long" `
        + '(anchors to the swept low) or "short" (anchors to the swept high). '
        + 'Omit it for the live read.',
    }, 400);
  }

  const res = await withFallback(
    () => bybitLtf(sym, now, fetcher(15)),
    () => okxLtf(sym, now, fetcher(15)),
  );
  if (!res.ok) {
    return json({
      symbol: sym.base, error: 'No venue could serve 15m candles',
      detail: res.err,
    }, 502);
  }

  const { source, bars } = res.val;
  const read = absorption(bars, { now, intervalMs: INTERVAL_15M, anchor });
  return json({ ts: now, symbol: sym.base, source, interval: '15m', ...read });
}

/**
 * Cross-market movers, awareness-only — see compute/movers.js and CLAUDE.md.
 * One call regardless of universe size: Bybit's tickers endpoint returns
 * every symbol's 24h stats at once, unlike every other route here.
 *
 * `?top100=BTC,ETH,...` is an optional cap-rank allowlist. Market-cap data
 * can't be fetched from the Worker itself — same shared-egress-IP rate-limit
 * problem as dominance (CLAUDE.md) — so the browser fetches it client-side
 * (src/marketcap.js) and relays it here, exactly like the `?etf=` override
 * relays a client-fetched number into the scored asset request.
 */
export async function handleMovers(url = null) {
  const now = Date.now();
  const res = await withFallback(
    () => bybitTickers(fetcher(30)),
    () => okxTickers(fetcher(30)),
  );
  if (!res.ok) {
    return json({
      ts: now, error: 'No venue could serve market tickers',
      detail: res.err,
    }, 502);
  }
  const raw = url?.searchParams.get('top100');
  const capBases = raw ? new Set(raw.split(',').filter(Boolean)) : null;
  const { source, tickers } = res.val;
  return json({ ts: now, source, items: rankMovers(tickers, MOVERS, capBases) });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/macro') return handleMacro(url);
    if (url.pathname === '/ltf') return handleLtf(url);
    if (url.pathname === '/movers') return handleMovers(url);
    return handleAsset(url);
  },
};
