import {
  normalizeKlines, INTERVAL_15M, INTERVAL_1H, INTERVAL_4H, dailyFromHourly,
} from '../compute/klines.js';

/** lookback(20) + evalBars(3) + headroom, in one call. */
export const LTF_BARS = 40;

const B = 'https://api.bybit.com';

/**
 * Core venue — reachable from the Cloudflare edge, unlike Binance.
 * FOUR calls, to keep a fan-out invocation cheap:
 *   tickers, NO symbol filter — every linear ticker in one payload. The URL
 *     is now IDENTICAL across every watchlist asset's concurrent invocation,
 *     so index.js's bucketed edge cache can collapse them onto one upstream
 *     hit; worst case (no collapsing) this still costs exactly one call, the
 *     same as the per-symbol shape it replaces.
 *   1H klines x200  (volatility-regime baseline, AND — re-normalized with the
 *     forming bar kept — today/yesterday's PDH/PDL via dailyFromHourly. This
 *     used to cost a dedicated daily-kline call; seven days of headroom in a
 *     series already being fetched makes that call redundant.)
 *   4H klines x200  (EMA34 / equilibrium / FVG / mode)
 *   OI history      (oiD1h / oiD4h; non-fatal)
 */
export async function bybitCore(sym, now, j) {
  const S = sym.bybit;
  const [tick, k1, k4, oiH] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=200`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=240&limit=200`),
    // NON-FATAL. Bybit serves open-interest from a CloudFront distribution that
    // geo-blocks this Cloudflare edge far more often than tickers/kline do, and
    // one missing sub-signal must never blank the whole asset row. On failure
    // score layer 3 simply reads 0 (flat OI) and everything else still renders.
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`)
      .catch(() => null),
  ]);

  const t = tick.result.list.find((x) => x.symbol === S);
  if (!t) throw new Error(`Bybit has no ticker for ${S}`);
  const mark = +t.lastPrice;

  const bars4h = normalizeKlines(k4.result.list, INTERVAL_4H, now);
  // Forming bar DROPPED: regime ranks the last bar that actually closed.
  const bars1h = normalizeKlines(k1.result.list, INTERVAL_1H, now);
  // Same payload, forming bar KEPT: today's running high/low is the sweep, so
  // PDH/PDL needs the hour in progress, not just closed ones.
  const { today, prevDay } = dailyFromHourly(normalizeKlines(k1.result.list, INTERVAL_1H, now, false));

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
    bars4h, bars1h, prevDay, today,
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
