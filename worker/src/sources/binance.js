const B = 'https://fapi.binance.com';

/**
 * Opportunistic only. fapi is geo-blocked from Indonesia AND from the Jakarta
 * Cloudflare edge, so this usually throws — callers must treat failure as
 * normal. The page also retries these from the user's own device, where a
 * phone or VPN often can reach Binance (see src/binance-enrich.js).
 */
export async function binanceExtras(sym, j) {
  const S = sym.binance;
  const [oiHist, taker, topls] = await Promise.all([
    j(`${B}/futures/data/openInterestHist?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
  ]);
  return {
    oiCoin: +oiHist[0].sumOpenInterest,
    taker: +taker[0].buySellRatio,
    topLS: +topls[0].longShortRatio,
  };
}
