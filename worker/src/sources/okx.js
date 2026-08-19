import { computeWalls } from '../compute/walls.js';
import { normalizeKlines, INTERVAL_4H, INTERVAL_1D } from '../compute/klines.js';

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
export async function okxCore(sym, now, j) {
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [k1h, k4h, kd, fund, oiHist, oiNow] = await Promise.all([
    j(`${O}/api/v5/market/candles?instId=${inst}&bar=1H&limit=2`),
    j(`${O}/api/v5/market/candles?instId=${inst}&bar=4H&limit=200`),
    j(`${O}/api/v5/market/candles?instId=${inst}&bar=1D&limit=2`),
    j(`${O}/api/v5/public/funding-rate?instId=${inst}`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/public/open-interest?instId=${inst}`).catch(() => null),
  ]);

  // Keep the forming 1H bar: its close IS the current traded price.
  const h1 = normalizeKlines(k1h.data, 60 * 60 * 1000, now, false);
  if (!h1.length) throw new Error(`OKX has no candles for ${inst}`);
  const mark = h1.at(-1).c;
  const prev1h = h1.length > 1 ? h1.at(-2).c : mark;

  const bars4h = normalizeKlines(k4h.data, INTERVAL_4H, now);
  const days = normalizeKlines(kd.data, INTERVAL_1D, now, false);
  const today = days.at(-1) ?? null;
  const prevDay = days.length > 1 ? days.at(-2) : null;

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
    bars4h, prevDay, today,
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
