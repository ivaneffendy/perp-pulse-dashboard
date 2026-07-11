/**
 * BTC Pulse — data proxy Worker
 *
 * Why this exists: the browser can't fetch exchange APIs directly (CORS is not
 * sent by Binance's `futures/data/*` endpoints, and `fapi` is geo-blocked in
 * some regions). This Worker fetches everything at Cloudflare's edge and returns
 * ONE JSON payload with permissive CORS, so the static page just calls this.
 *
 * Scope (v1): BTC perps confluence snapshot — price, funding, aggregated OI
 * across Binance+Bybit+OKX, positioning (taker / top-trader L/S), and the
 * nearest order-book walls. All free, all snapshot (no persistent state).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Cache each upstream call briefly at the edge so rapid refreshes don't hammer
// the exchanges (and stay well inside rate limits).
const EDGE_TTL = 5; // seconds

async function j(url) {
  const r = await fetch(url, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Settle-all helper: never let one dead venue sink the whole response.
async function safe(promise, label) {
  try {
    return await promise;
  } catch (e) {
    console.log(`[${label}] ${e.message}`);
    return null;
  }
}

/**
 * Order-book walls from a REST depth snapshot.
 * The visible REST book is shallow (~0.1% of price), so "nearest wall" means the
 * heaviest cluster of resting size right around price — exactly what matters when
 * price is approaching a POI. We bucket levels into ~0.05%-wide price bins and
 * pick the heaviest bin on each side, plus the visible-book bid/ask imbalance.
 */
function computeWalls(bids, asks, mid) {
  const binSize = Math.max(1, Math.round(mid * 0.0005)); // ~0.05% of price
  const bucket = (levels) => {
    const bins = new Map();
    let vol = 0;
    for (const [pStr, qStr] of levels) {
      const price = +pStr, qty = +qStr;
      if (!isFinite(price) || !isFinite(qty)) continue;
      vol += qty;
      const key = Math.round(price / binSize) * binSize;
      bins.set(key, (bins.get(key) || 0) + qty);
    }
    let wall = null;
    for (const [price, size] of bins) {
      if (!wall || size > wall.size) wall = { price, size };
    }
    if (wall) wall.distPct = (wall.price / mid - 1) * 100;
    return { wall, vol };
  };

  const b = bucket(bids);
  const a = bucket(asks);
  const total = b.vol + a.vol;
  return {
    bidWall: b.wall,   // { price, size (BTC), distPct (negative) }
    askWall: a.wall,   // { price, size (BTC), distPct (positive) }
    bidVol: b.vol,
    askVol: a.vol,
    imbalancePct: total ? (b.vol / total) * 100 : 50, // >50 = more resting bids
  };
}

async function fromBinance() {
  const B = 'https://fapi.binance.com';
  const S = 'BTCUSDT';
  const [t24, prem, kl, oiHist, taker, topls, depth] = await Promise.all([
    j(`${B}/fapi/v1/ticker/24hr?symbol=${S}`),
    j(`${B}/fapi/v1/premiumIndex?symbol=${S}`),
    j(`${B}/fapi/v1/klines?symbol=${S}&interval=1h&limit=5`),
    j(`${B}/futures/data/openInterestHist?symbol=${S}&period=1h&limit=5`),
    j(`${B}/futures/data/takerlongshortRatio?symbol=${S}&period=1h&limit=1`),
    j(`${B}/futures/data/topLongShortPositionRatio?symbol=${S}&period=1h&limit=1`),
    j(`${B}/fapi/v1/depth?symbol=${S}&limit=1000`),
  ]);

  const mark = +prem.markPrice;
  const closes = kl.map((k) => +k[4]);
  const oiNow = +oiHist[4].sumOpenInterest;
  const oi1h = +oiHist[3].sumOpenInterest;
  const oi4h = +oiHist[0].sumOpenInterest;

  return {
    source: 'Binance USDT-M',
    mark,
    chg1h: (mark / closes[3] - 1) * 100,
    chg4h: (mark / closes[0] - 1) * 100,
    chg24h: +t24.priceChangePercent,
    funding: +prem.lastFundingRate * 100,
    nextFundingTime: +prem.nextFundingTime,
    oiBtc: oiNow,
    oiUsd: +oiHist[4].sumOpenInterestValue,
    oiD1h: (oiNow / oi1h - 1) * 100,
    oiD4h: (oiNow / oi4h - 1) * 100,
    taker: +taker[0].buySellRatio,
    topLS: +topls[0].longShortRatio,
    book: computeWalls(depth.bids, depth.asks, mark),
  };
}

async function fromBybit() {
  const B = 'https://api.bybit.com';
  const S = 'BTCUSDT';
  const [tick, kl, oiH, ob] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear&symbol=${S}`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=5`),
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`),
    j(`${B}/v5/market/orderbook?category=linear&symbol=${S}&limit=200`),
  ]);
  const t = tick.result.list[0];
  const mark = +t.lastPrice;
  const closes = kl.result.list.map((k) => +k[4]); // newest first
  const oiL = oiH.result.list; // newest first
  const oiNow = +oiL[0].openInterest, oi1h = +oiL[1].openInterest, oi4h = +oiL[4].openInterest;

  return {
    source: 'Bybit linear (fallback)',
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
    taker: null,
    topLS: null,
    book: computeWalls(ob.result.b, ob.result.a, mark),
  };
}

// OI-only helpers for the cross-venue aggregate (BTC-denominated).
async function bybitOiBtc() {
  const d = await j('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
  return +d.result.list[0].openInterest; // linear USDT perp OI is in BTC
}
async function okxOiBtc() {
  const d = await j('https://www.okx.com/api/v5/public/open-interest?instId=BTC-USDT-SWAP');
  return +d.data[0].oiCcy; // OI expressed in BTC
}

function verdict(d) {
  const pDown = d.chg1h < -0.15, pUp = d.chg1h > 0.15;
  const oiDown = d.oiD1h < -0.25, oiUp = d.oiD1h > 0.25;
  let cls = 'mixed', msg;

  if (pDown && oiDown) {
    cls = 'ok';
    msg = `Price down ${d.chg1h.toFixed(2)}% with OI dropping ${d.oiD1h.toFixed(2)}% — longs closing or getting flushed, not fresh selling. Deleveraging pullback; POI mitigation has better odds of holding.`;
  } else if (pDown && oiUp) {
    cls = 'risk';
    msg = `Price down ${d.chg1h.toFixed(2)}% while OI is building +${d.oiD1h.toFixed(2)}% — new shorts opening into the move. Aggressive selling, not a healthy pullback. Want stronger confirmation.`;
  } else if (pUp && oiUp) {
    cls = 'ok';
    msg = `Price up +${d.chg1h.toFixed(2)}% with OI expanding +${d.oiD1h.toFixed(2)}% — fresh longs backing the move with new money.`;
  } else if (pUp && oiDown) {
    cls = 'mixed';
    msg = `Price up +${d.chg1h.toFixed(2)}% but OI shrinking ${d.oiD1h.toFixed(2)}% — likely short covering, weaker fuel for continuation.`;
  } else {
    msg = `Flat hour (${d.chg1h.toFixed(2)}% price, ${d.oiD1h.toFixed(2)}% OI). No strong positioning signal — lean on your HTF structure.`;
  }

  if (d.funding <= -0.01) msg += ` Funding negative (${d.funding.toFixed(4)}%): shorts paying, crowded downside — squeeze fuel.`;
  else if (d.funding >= 0.02) msg += ` Funding elevated (${d.funding.toFixed(4)}%): longs crowded, watch for a flush.`;

  if (d.taker != null) {
    if (d.taker < 0.9) msg += ` Taker flow ${d.taker.toFixed(2)} — sellers hitting market.`;
    else if (d.taker > 1.1) msg += ` Taker flow ${d.taker.toFixed(2)} — buyers lifting offers.`;
  }

  // Order-book wall read: which side is the nearer magnet + resting imbalance.
  const bk = d.book;
  if (bk && bk.bidWall && bk.askWall) {
    const askD = bk.askWall.distPct, bidD = Math.abs(bk.bidWall.distPct);
    const nearer = askD < bidD ? 'ask' : 'bid';
    const skew = bk.imbalancePct >= 55 ? 'bids stacked' : bk.imbalancePct <= 45 ? 'asks stacked' : 'balanced';
    msg += ` Book: nearest ${nearer} wall ${nearer === 'ask' ? '+' : '-'}${(nearer === 'ask' ? askD : bidD).toFixed(2)}%, resting ${skew} (${bk.imbalancePct.toFixed(0)}% bid).`;
  }

  return { cls, msg };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // Primary snapshot: Binance, fall back to Bybit for the core read.
      let d = await safe(fromBinance(), 'binance');
      if (!d) d = await fromBybit(); // let this throw if both are dead

      // Cross-venue aggregate OI (best-effort; missing venues just drop out).
      const [bybOi, okxOi] = await Promise.all([
        safe(bybitOiBtc(), 'bybit-oi'),
        safe(okxOiBtc(), 'okx-oi'),
      ]);
      const venues = { binance: d.source.startsWith('Binance') ? d.oiBtc : null, bybit: bybOi, okx: okxOi };
      const parts = Object.values(venues).filter((v) => v != null);
      const aggBtc = parts.reduce((s, v) => s + v, 0);

      const payload = {
        ts: Date.now(),
        source: d.source,
        price: { mark: d.mark, chg1h: d.chg1h, chg4h: d.chg4h, chg24h: d.chg24h },
        funding: { rate: d.funding, nextFundingTime: d.nextFundingTime },
        oi: {
          btc: d.oiBtc,
          usd: d.oiUsd,
          d1h: d.oiD1h,
          d4h: d.oiD4h,
          aggBtc,
          aggUsd: aggBtc * d.mark,
          venues,
        },
        positioning: { taker: d.taker, topLS: d.topLS },
        book: d.book,
        verdict: verdict(d),
      };

      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Upstream exchanges unreachable', detail: e.message }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }
  },
};
