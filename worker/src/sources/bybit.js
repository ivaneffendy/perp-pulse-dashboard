import { normalizeKlines, INTERVAL_15M, INTERVAL_4H, INTERVAL_1D } from '../compute/klines.js';

/** lookback(20) + evalBars(3) + headroom, in one call. */
export const LTF_BARS = 40;

const B = 'https://api.bybit.com';

/**
 * Core venue — reachable from the Cloudflare edge, unlike Binance.
 * Exactly FOUR calls, to keep a fan-out invocation cheap:
 *   tickers (price, chg1h via prevPrice1h, chg24h, funding, OI level)
 *   4H klines x200  (EMA34 / equilibrium / FVG / mode)
 *   1D klines x2    (PDH/PDL — keeps the forming candle)
 *   OI history      (oiD1h / oiD4h)
 */
export async function bybitCore(sym, now, j) {
  const S = sym.bybit;
  const [tick, k4, kd, oiH] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear&symbol=${S}`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=240&limit=200`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=D&limit=2`),
    // NON-FATAL. Bybit serves open-interest from a CloudFront distribution that
    // geo-blocks this Cloudflare edge far more often than tickers/kline do, and
    // one missing sub-signal must never blank the whole asset row. On failure
    // score layer 3 simply reads 0 (flat OI) and everything else still renders.
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`)
      .catch(() => null),
  ]);

  const t = tick.result.list[0];
  if (!t) throw new Error(`Bybit has no ticker for ${S}`);
  const mark = +t.lastPrice;

  const bars4h = normalizeKlines(k4.result.list, INTERVAL_4H, now);
  // Daily KEEPS the forming candle: today's running high/low is the sweep.
  const days = normalizeKlines(kd.result.list, INTERVAL_1D, now, false);
  const today = days.at(-1) ?? null;
  const prevDay = days.length > 1 ? days.at(-2) : null;

  const oiL = oiH?.result?.list ?? []; // newest first; empty when geo-blocked
  const oiNow = +oiL[0]?.openInterest;
  const oi1h = +oiL[1]?.openInterest;
  const oi4h = +oiL[4]?.openInterest;

  return {
    source: 'Bybit linear',
    mark,
    chg1h: t.prevPrice1h ? (mark / +t.prevPrice1h - 1) * 100 : 0,
    chg24h: +t.price24hPcnt * 100,
    funding: +t.fundingRate * 100,
    nextFundingTime: +t.nextFundingTime,
    oiCoin: Number.isFinite(oiNow) ? oiNow : 0,
    oiUsd: (Number.isFinite(oiNow) ? oiNow : 0) * mark,
    oiD1h: Number.isFinite(oi1h) && oi1h ? (oiNow / oi1h - 1) * 100 : 0,
    oiD4h: Number.isFinite(oi4h) && oi4h ? (oiNow / oi4h - 1) * 100 : 0,
    oiMissing: oiL.length === 0,
    bars4h, prevDay, today,
  };
}

/**
 * /ltf only — ONE call, because the whole point of the route is that pressing
 * the button costs a single upstream request.
 *
 * The forming candle is KEPT (dropUnclosed = false), like the daily sweep bar
 * and unlike every other series: the tap being judged is happening right now.
 */
export async function bybitLtf(sym, now, j) {
  const k = await j(
    `${B}/v5/market/kline?category=linear&symbol=${sym.bybit}&interval=15&limit=${LTF_BARS}`);
  const bars = normalizeKlines(k.result.list, INTERVAL_15M, now, false);
  if (!bars.length) throw new Error(`Bybit has no 15m klines for ${sym.bybit}`);
  return { source: 'Bybit linear', bars };
}

/** deep=1 only: book walls, account L/S, and the 4h change for display. */
export async function bybitDeep(sym, j) {
  const S = sym.bybit;
  const [ob, acct, k1h] = await Promise.all([
    j(`${B}/v5/market/orderbook?category=linear&symbol=${S}&limit=500`).catch(() => null),
    j(`${B}/v5/market/account-ratio?category=linear&symbol=${S}&period=1h&limit=1`).catch(() => null),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=5`).catch(() => null),
  ]);
  const r = acct?.result?.list?.[0];
  const closes = k1h?.result?.list?.map((k) => +k[4]); // newest first
  return {
    raw: ob?.result ?? null,
    accountLS: r ? +r.buyRatio / +r.sellRatio : null,
    close4hAgo: closes?.[4] ?? null,
  };
}
