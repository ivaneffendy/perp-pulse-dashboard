/**
 * Hybrid enrichment. Binance is geo-blocked from the Worker's edge, but the
 * USER's device (phone, VPN) often reaches it. So after the OKX/Bybit baseline
 * paints, try Binance directly from the browser. On a blocked network these
 * abort fast and the baseline simply stands.
 */
const BINANCE = 'https://fapi.binance.com';

async function jTimeout(url, ms = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * @param {object} d                 the deep asset payload (mutated in place)
 * @param {() => boolean} isCurrent  false if the user has since switched pair
 * @returns {Promise<boolean>}       whether anything was enriched
 */
export async function enrichBinance(d, isCurrent) {
  const S = d.symbol + 'USDT';
  let touched = false;

  try {
    const oi = await jTimeout(`${BINANCE}/fapi/v1/openInterest?symbol=${S}`);
    if (!isCurrent()) return false;
    d.oi.venues = { ...(d.oi.venues ?? {}), binance: +oi.openInterest };
    d.oi.aggCoin = Object.values(d.oi.venues).filter((v) => v != null).reduce((s, v) => s + v, 0);
    d.oi.aggUsd = d.oi.aggCoin * d.price.mark;
    touched = true;
  } catch { /* blocked network — expected, keep the baseline */ }

  try {
    const [taker, topls] = await Promise.all([
      jTimeout(`${BINANCE}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
      jTimeout(`${BINANCE}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
    ]);
    if (!isCurrent()) return touched;
    d.positioning = {
      taker: +taker[0].buySellRatio,
      topLS: +topls[0].longShortRatio,
      source: 'Binance top-trader (direct)',
    };
    touched = true;
  } catch { /* blocked network — expected, keep the baseline */ }

  return touched;
}
