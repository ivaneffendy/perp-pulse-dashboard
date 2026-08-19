/**
 * BTC Pulse — data proxy Worker
 *
 * Why this exists: the browser can't fetch exchange APIs directly (CORS + geo).
 * This Worker fetches at Cloudflare's edge and returns ONE JSON payload with
 * permissive CORS, so the static page just calls this.
 *
 * IMPORTANT regional reality: Binance (fapi.binance.com) is geo-blocked in
 * Indonesia and the Cloudflare edge nearest the user (Jakarta) hits the same
 * block, so Binance calls fail. Therefore this Worker is built on **Bybit +
 * OKX** (both reachable) and treats Binance as an OPPORTUNISTIC bonus only.
 * Every field has a Bybit/OKX source so the dashboard is fully populated even
 * with Binance down. The `diag` field reports which venues answered.
 */

import { computeWalls } from './compute/walls.js';
import { verdict } from './verdict.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EDGE_TTL = 5; // seconds — brief edge cache so rapid refreshes stay polite

// Supported pairs (allowlist). IDs derive deterministically from the base coin;
// keeping an explicit map both documents the set and prevents arbitrary ?symbol=
// strings from being interpolated into upstream URLs (SSRF-style shaping).
const PAIRS = {
  BTC:  { bybit: 'BTCUSDT',  okxInst: 'BTC-USDT-SWAP',  okxCcy: 'BTC',  binance: 'BTCUSDT'  },
  ETH:  { bybit: 'ETHUSDT',  okxInst: 'ETH-USDT-SWAP',  okxCcy: 'ETH',  binance: 'ETHUSDT'  },
  SOL:  { bybit: 'SOLUSDT',  okxInst: 'SOL-USDT-SWAP',  okxCcy: 'SOL',  binance: 'SOLUSDT'  },
  XRP:  { bybit: 'XRPUSDT',  okxInst: 'XRP-USDT-SWAP',  okxCcy: 'XRP',  binance: 'XRPUSDT'  },
  BNB:  { bybit: 'BNBUSDT',  okxInst: 'BNB-USDT-SWAP',  okxCcy: 'BNB',  binance: 'BNBUSDT'  },
  DOGE: { bybit: 'DOGEUSDT', okxInst: 'DOGE-USDT-SWAP', okxCcy: 'DOGE', binance: 'DOGEUSDT' },
  ADA:  { bybit: 'ADAUSDT',  okxInst: 'ADA-USDT-SWAP',  okxCcy: 'ADA',  binance: 'ADAUSDT'  },
  LINK: { bybit: 'LINKUSDT', okxInst: 'LINK-USDT-SWAP', okxCcy: 'LINK', binance: 'LINKUSDT' },
  SUI:  { bybit: 'SUIUSDT',  okxInst: 'SUI-USDT-SWAP',  okxCcy: 'SUI',  binance: 'SUIUSDT'  },
  HYPE: { bybit: 'HYPEUSDT', okxInst: 'HYPE-USDT-SWAP', okxCcy: 'HYPE', binance: 'HYPEUSDT' },
};

function resolveSymbol(url) {
  const raw = (new URL(url).searchParams.get('symbol') || 'BTC').toUpperCase();
  const p = PAIRS[raw] || PAIRS.BTC;
  return { base: PAIRS[raw] ? raw : 'BTC', ...p };
}

async function j(url) {
  const r = await fetch(url, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
  if (!r.ok) throw new Error(`${url.replace(/\?.*/, '')} -> ${r.status}`);
  return r.json();
}

// Run a source, capturing success value or error message (for diag).
async function attempt(fn) {
  try {
    return { ok: true, val: await fn() };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/* ------------------------------ Bybit (core) ------------------------------ */
// Primary source: price, funding, OI + deltas, order-book walls. Reachable.
async function bybit(sym) {
  const B = 'https://api.bybit.com';
  const S = sym.bybit;
  const [tick, kl, oiH, ob, acct] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear&symbol=${S}`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=5`),
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`),
    j(`${B}/v5/market/orderbook?category=linear&symbol=${S}&limit=500`),
    j(`${B}/v5/market/account-ratio?category=linear&symbol=${S}&period=1h&limit=1`).catch(() => null),
  ]);
  const t = tick.result.list[0];
  const mark = +t.lastPrice;
  const closes = kl.result.list.map((k) => +k[4]); // newest first
  const oiL = oiH.result.list; // newest first
  const oiNow = +oiL[0].openInterest, oi1h = +oiL[1].openInterest, oi4h = +oiL[4].openInterest;
  const ratio = acct && acct.result && acct.result.list && acct.result.list[0];
  return {
    source: 'Bybit linear',
    mark,
    chg1h: (mark / closes[1] - 1) * 100,
    chg4h: (mark / closes[4] - 1) * 100,
    chg24h: +t.price24hPcnt * 100,
    funding: +t.fundingRate * 100,
    nextFundingTime: +t.nextFundingTime,
    oiBtc: oiNow,
    oiUsd: oiNow * mark,
    oiD1h: (oiNow / oi1h - 1) * 100,
    oiD4h: (oiNow / oi4h - 1) * 100,
    // Fallback walls source (Bybit); OKX books-full is preferred when reachable.
    book: (() => { const b = computeWalls(ob.result.b, ob.result.a); if (b) b.source = 'Bybit'; return b; })(),
    // Bybit account long/short ratio (fallback for positioning)
    accountLS: ratio ? +ratio.buyRatio / +ratio.sellRatio : null,
  };
}

/* ------------------------------ OKX (extras) ------------------------------ */
// OI (BTC) + taker buy/sell + long/short account ratio. Reachable; replaces the
// Binance-only positioning signals.
async function okx(sym) {
  const O = 'https://www.okx.com';
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [oi, taker, ls, ob, instr] = await Promise.all([
    j(`${O}/api/v5/public/open-interest?instId=${inst}`),
    j(`${O}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1H`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`).catch(() => null),
    // Deepest free REST book (~5000 levels/side) — widest reachable wall coverage.
    j(`${O}/api/v5/market/books-full?instId=${inst}&sz=5000`).catch(() => null),
    // Contract spec — OKX book sizes are in CONTRACTS; ctVal converts to base coin.
    j(`${O}/api/v5/public/instruments?instType=SWAP&instId=${inst}`).catch(() => null),
  ]);
  const oiBtc = +oi.data[0].oiCcy;
  // taker-volume rows: [ts, sellVol, buyVol] (newest first)
  let takerRatio = null;
  if (taker && taker.data && taker.data[0]) {
    const sell = +taker.data[0][1], buy = +taker.data[0][2];
    takerRatio = sell ? buy / sell : null;
  }
  // long-short-account-ratio rows: [ts, ratio] (newest first)
  let lsRatio = null;
  if (ls && ls.data && ls.data[0]) lsRatio = +ls.data[0][1];
  // Order-book walls (preferred source — deeper than Bybit)
  let book = null;
  if (ob && ob.data && ob.data[0]) {
    const ctVal = instr && instr.data && instr.data[0] ? +instr.data[0].ctVal : 1;
    const scale = isFinite(ctVal) && ctVal > 0 ? ctVal : 1; // contracts -> base coin
    const conv = (lv) => lv.map((l) => [l[0], +l[1] * scale]);
    book = computeWalls(conv(ob.data[0].bids), conv(ob.data[0].asks));
    if (book) book.source = 'OKX books-full';
  }
  return { oiBtc, taker: takerRatio, ls: lsRatio, book };
}

/* ----------------------- Binance (opportunistic only) --------------------- */
// If reachable (it usually isn't, from ID/Jakarta), gives the richest data:
// its own OI, taker buy/sell, and TOP-trader L/S. Never depended upon.
async function binance(sym) {
  const B = 'https://fapi.binance.com';
  const S = sym.binance;
  const [oiHist, taker, topls] = await Promise.all([
    j(`${B}/futures/data/openInterestHist?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
  ]);
  return {
    oiBtc: +oiHist[0].sumOpenInterest,
    taker: +taker[0].buySellRatio,
    topLS: +topls[0].longShortRatio,
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const debug = new URL(request.url).searchParams.has('debug');
    const showBins = new URL(request.url).searchParams.has('bins');
    const sym = resolveSymbol(request.url);

    // Fetch all three venues concurrently; Bybit is the required core.
    const [by, ok, bn] = await Promise.all([
      attempt(() => bybit(sym)),
      attempt(() => okx(sym)),
      attempt(() => binance(sym)),
    ]);

    if (!by.ok) {
      return new Response(
        JSON.stringify({ error: 'Core source (Bybit) unreachable', detail: by.err, diag: { okx: ok.ok, binance: bn.ok } }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }

    const core = by.val;
    const okv = ok.ok ? ok.val : null;
    const bnv = bn.ok ? bn.val : null;

    // Aggregated OI (BTC) across whatever venues answered.
    const venues = {
      binance: bnv ? bnv.oiBtc : null,
      bybit: core.oiBtc,
      okx: okv ? okv.oiBtc : null,
    };
    const aggBtc = Object.values(venues).filter((v) => v != null).reduce((s, v) => s + v, 0);

    // Positioning: prefer Binance (top-trader) → OKX → Bybit account ratio.
    const taker = (bnv && bnv.taker) ?? (okv && okv.taker) ?? null;
    const topLS = (bnv && bnv.topLS) ?? (okv && okv.ls) ?? core.accountLS ?? null;
    const posSource = bnv && bnv.topLS != null ? 'Binance top-trader'
      : okv && okv.ls != null ? 'OKX accounts'
      : core.accountLS != null ? 'Bybit accounts' : 'n/a';

    // Walls: prefer OKX books-full (deepest), fall back to Bybit's book.
    const book = (okv && okv.book) || core.book;
    if (book && !showBins) { delete book.bid.dbg; delete book.ask.dbg; }

    const d = {
      mark: core.mark, chg1h: core.chg1h, chg4h: core.chg4h, chg24h: core.chg24h,
      funding: core.funding, oiD1h: core.oiD1h, book, taker,
    };

    const payload = {
      ts: Date.now(),
      symbol: sym.base,
      source: core.source + (bnv ? ' + Binance' : '') + (okv ? ' + OKX' : ''),
      price: { mark: core.mark, chg1h: core.chg1h, chg4h: core.chg4h, chg24h: core.chg24h },
      funding: { rate: core.funding, nextFundingTime: core.nextFundingTime },
      oi: { btc: core.oiBtc, usd: core.oiUsd, d1h: core.oiD1h, d4h: core.oiD4h, aggBtc, aggUsd: aggBtc * core.mark, venues },
      positioning: { taker, topLS, source: posSource },
      book,
      verdict: verdict(d),
    };

    if (debug) {
      payload.diag = {
        bybit: by.ok ? 'ok' : by.err,
        okx: ok.ok ? 'ok' : ok.err,
        binance: bn.ok ? 'ok' : bn.err,
      };
    }

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
    });
  },
};
