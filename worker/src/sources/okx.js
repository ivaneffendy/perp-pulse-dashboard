import { computeWalls } from '../compute/walls.js';
import { normalizeKlines, dailyFromHourly, INTERVAL_15M, INTERVAL_1H, INTERVAL_4H } from '../compute/klines.js';
import { LTF_BARS } from './bybit.js';
import { VALID_BASE } from '../pairs.js';

const O = 'https://www.okx.com';

/**
 * CORE fallback, same shape as bybitCore().
 *
 * Bybit's CloudFront intermittently geo-blocks Cloudflare edge egress — measured
 * ~28% of requests failing with "configured to block access from your country",
 * while OKX answered 10/10 from the same edge. Bybit stays primary (richer OI
 * history); this takes over per-asset whenever Bybit fails, so one venue's geo
 * policy can no longer blank a row.
 *
 * OKX candle rows are [ts, o, h, l, c, vol, ...] — the same field order as
 * Bybit, so normalizeKlines consumes them unchanged.
 */
/**
 * /ltf fallback. Required, not optional: Bybit's CDN geo-blocks this edge
 * intermittently, so a route with no fallback would fail exactly when the rest
 * of the dashboard is already degraded. Same row order, so normalizeKlines
 * consumes it unchanged.
 */
export async function okxLtf(sym, now, j) {
  const k = await j(
    `${O}/api/v5/market/candles?instId=${sym.okxInst}&bar=15m&limit=${LTF_BARS}`);
  const bars = normalizeKlines(k.data, INTERVAL_15M, now, false);
  if (!bars.length) throw new Error(`OKX has no 15m candles for ${sym.okxInst}`);
  return { source: 'OKX SWAP', bars };
}

export async function okxCore(sym, now, j) {
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [k1h, k4h, fund, oiHist, oiNow] = await Promise.all([
    // limit 200, not 2: the same candles now serve the mark price, the
    // volatility-regime baseline, AND today/prevDay below — no extra
    // subrequest for any of the three.
    j(`${O}/api/v5/market/candles?instId=${inst}&bar=1H&limit=200`),
    j(`${O}/api/v5/market/candles?instId=${inst}&bar=4H&limit=200`),
    j(`${O}/api/v5/public/funding-rate?instId=${inst}`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/public/open-interest?instId=${inst}`).catch(() => null),
  ]);

  // Keep the forming 1H bar: its close IS the current traded price, and
  // today's daily bar (below) needs the still-forming hour's running high/low.
  const h1 = normalizeKlines(k1h.data, INTERVAL_1H, now, false);
  if (!h1.length) throw new Error(`OKX has no candles for ${inst}`);
  // Same payload, forming bar dropped — regime ranks only closed bars. No
  // second fetch: this is a re-normalize of rows already in hand.
  const bars1h = normalizeKlines(k1h.data, INTERVAL_1H, now);
  const mark = h1.at(-1).c;
  const prev1h = h1.length > 1 ? h1.at(-2).c : mark;

  const bars4h = normalizeKlines(k4h.data, INTERVAL_4H, now);
  // NOT OKX's native bar=1D — that buckets at UTC+8 midnight, not UTC (see
  // CLAUDE.md). Rebuilt from the UTC-aligned hourly bars above instead, so
  // PDH/PDL means the same "day" here as it does on a Bybit-served row.
  const { today, prevDay } = dailyFromHourly(h1);

  const f = fund?.data?.[0];
  // rubik rows are [ts, oi, vol], newest first. Units cancel in the ratios.
  const oiRows = oiHist?.data ?? [];
  const o0 = +oiRows[0]?.[1], o1 = +oiRows[1]?.[1], o4 = +oiRows[4]?.[1];
  const coin = oiNow?.data?.[0] ? +oiNow.data[0].oiCcy : 0;

  return {
    source: 'OKX SWAP',
    mark,
    chg1h: prev1h ? (mark / prev1h - 1) * 100 : 0,
    chg24h: 0, // OKX ticker not fetched on this path; display-only, not scored.
    funding: f ? +f.fundingRate * 100 : 0,
    nextFundingTime: f ? +f.nextFundingTime : Date.now(),
    oiCoin: coin,
    oiUsd: coin * mark,
    oiD1h: Number.isFinite(o0) && Number.isFinite(o1) && o1 ? (o0 / o1 - 1) * 100 : 0,
    oiD4h: Number.isFinite(o0) && Number.isFinite(o4) && o4 ? (o0 / o4 - 1) * 100 : 0,
    bars4h, bars1h, prevDay, today,
  };
}

/** OI level + 1h/4h deltas from OKX, used to patch a geo-blocked Bybit OI. */
export async function okxOpenInterest(sym, j) {
  const [hist, now] = await Promise.all([
    j(`${O}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${sym.okxCcy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/public/open-interest?instId=${sym.okxInst}`).catch(() => null),
  ]);
  const rows = hist?.data ?? [];               // [ts, oi, vol], newest first
  const o0 = +rows[0]?.[1], o1 = +rows[1]?.[1], o4 = +rows[4]?.[1];
  const coin = now?.data?.[0] ? +now.data[0].oiCcy : null;
  if (coin == null && !Number.isFinite(o0)) return null;
  return {
    oiCoin: coin ?? 0,
    oiUsd: 0, // filled by the caller against its own mark
    oiD1h: Number.isFinite(o0) && Number.isFinite(o1) && o1 ? (o0 / o1 - 1) * 100 : 0,
    oiD4h: Number.isFinite(o0) && Number.isFinite(o4) && o4 ? (o0 / o4 - 1) * 100 : 0,
    oiMissing: false,
  };
}

/**
 * OKX extras — taker flow, account L/S, OI, and the deepest free REST book.
 * Every call is individually optional: a missing instrument (HYPE and the
 * newer listings are the risk) degrades to Bybit rather than failing the row.
 */
export async function okxExtras(sym, j) {
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [oi, taker, ls, ob, instr] = await Promise.all([
    j(`${O}/api/v5/public/open-interest?instId=${inst}`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1H`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/market/books-full?instId=${inst}&sz=5000`).catch(() => null),
    j(`${O}/api/v5/public/instruments?instType=SWAP&instId=${inst}`).catch(() => null),
  ]);

  // taker-volume rows are [ts, sellVol, buyVol], newest first
  let takerRatio = null;
  const tr = taker?.data?.[0];
  if (tr) { const sell = +tr[1], buy = +tr[2]; takerRatio = sell ? buy / sell : null; }

  let book = null;
  if (ob?.data?.[0]) {
    // OKX book sizes are in CONTRACTS; ctVal converts to base coin.
    const ctVal = +instr?.data?.[0]?.ctVal;
    const scale = Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1;
    const conv = (lv) => lv.map((l) => [l[0], +l[1] * scale]);
    book = computeWalls(conv(ob.data[0].bids), conv(ob.data[0].asks));
    if (book) book.source = 'OKX books-full';
  }

  return {
    oiCoin: oi?.data?.[0] ? +oi.data[0].oiCcy : null,
    taker: takerRatio,
    ls: ls?.data?.[0] ? +ls.data[0][1] : null,
    book,
  };
}

/**
 * ALL USDT-margined SWAP tickers in ONE call — /movers fallback when Bybit's
 * CDN geo-blocks this edge. Two things this endpoint does NOT give directly:
 *
 * 1. No 24h %-change field — derived from open24h/last, same arithmetic as
 *    okxCore() above.
 * 2. `volCcy24h` is in BASE-COIN units, not USD (confirmed against live data:
 *    for ETH-USDT-SWAP, vol24h(contracts) / volCcy24h = 10 exactly, OKX's own
 *    contract multiplier for that instrument). Multiplying by `last` gets USD
 *    notional, comparable to Bybit's turnover24h.
 */
export async function okxTickers(j) {
  const r = await j(`${O}/api/v5/market/tickers?instType=SWAP`);
  const list = r?.data ?? [];
  const tickers = list
    .filter((t) => t.instId.endsWith('-USDT-SWAP'))
    .map((t) => {
      const open = +t.open24h, last = +t.last, volCcy = +t.volCcy24h;
      return {
        base: t.instId.replace(/-USDT-SWAP$/, ''),
        pct24h: open ? (last / open - 1) * 100 : NaN,
        turnover24h: volCcy * last,
      };
    })
    .filter((t) => Number.isFinite(t.pct24h) && Number.isFinite(t.turnover24h) && VALID_BASE.test(t.base));
  if (!tickers.length) throw new Error('OKX returned no USDT SWAP tickers');
  return { source: 'OKX SWAP', tickers };
}
