import { normalizeKlines, INTERVAL_4H, INTERVAL_1D } from '../compute/klines.js';

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
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`),
  ]);

  const t = tick.result.list[0];
  if (!t) throw new Error(`Bybit has no ticker for ${S}`);
  const mark = +t.lastPrice;

  const bars4h = normalizeKlines(k4.result.list, INTERVAL_4H, now);
  // Daily KEEPS the forming candle: today's running high/low is the sweep.
  const days = normalizeKlines(kd.result.list, INTERVAL_1D, now, false);
  const today = days.at(-1) ?? null;
  const prevDay = days.length > 1 ? days.at(-2) : null;

  const oiL = oiH.result.list ?? []; // newest first
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
    bars4h, prevDay, today,
  };
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
