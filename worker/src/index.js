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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EDGE_TTL = 5; // seconds — brief edge cache so rapid refreshes stay polite

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

/**
 * Order-book walls from a REST depth snapshot. The visible REST book is shallow
 * (~0.1% of price), so "nearest wall" = heaviest cluster of resting size right
 * around price. We bucket levels into ~0.05%-wide bins, pick the heaviest bin
 * each side, plus the visible-book bid/ask imbalance.
 * `levels` = array of [priceStr, qtyStr].
 */
function computeWalls(bids, asks, mid) {
  const binSize = Math.max(1, Math.round(mid * 0.0005));
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
    for (const [price, size] of bins) if (!wall || size > wall.size) wall = { price, size };
    if (wall) wall.distPct = (wall.price / mid - 1) * 100;
    return { wall, vol };
  };
  const b = bucket(bids), a = bucket(asks);
  const total = b.vol + a.vol;
  return {
    bidWall: b.wall,
    askWall: a.wall,
    bidVol: b.vol,
    askVol: a.vol,
    imbalancePct: total ? (b.vol / total) * 100 : 50,
  };
}

/* ------------------------------ Bybit (core) ------------------------------ */
// Primary source: price, funding, OI + deltas, order-book walls. Reachable.
async function bybit() {
  const B = 'https://api.bybit.com';
  const S = 'BTCUSDT';
  const [tick, kl, oiH, ob, acct] = await Promise.all([
    j(`${B}/v5/market/tickers?category=linear&symbol=${S}`),
    j(`${B}/v5/market/kline?category=linear&symbol=${S}&interval=60&limit=5`),
    j(`${B}/v5/market/open-interest?category=linear&symbol=${S}&intervalTime=1h&limit=5`),
    j(`${B}/v5/market/orderbook?category=linear&symbol=${S}&limit=200`),
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
    book: computeWalls(ob.result.b, ob.result.a, mark),
    // Bybit account long/short ratio (fallback for positioning)
    accountLS: ratio ? +ratio.buyRatio / +ratio.sellRatio : null,
  };
}

/* ------------------------------ OKX (extras) ------------------------------ */
// OI (BTC) + taker buy/sell + long/short account ratio. Reachable; replaces the
// Binance-only positioning signals.
async function okx() {
  const O = 'https://www.okx.com';
  const [oi, taker, ls] = await Promise.all([
    j(`${O}/api/v5/public/open-interest?instId=BTC-USDT-SWAP`),
    j(`${O}/api/v5/rubik/stat/taker-volume?ccy=BTC&instType=CONTRACTS&period=1H`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H`).catch(() => null),
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
  return { oiBtc, taker: takerRatio, ls: lsRatio };
}

/* ----------------------- Binance (opportunistic only) --------------------- */
// If reachable (it usually isn't, from ID/Jakarta), gives the richest data:
// its own OI, taker buy/sell, and TOP-trader L/S. Never depended upon.
async function binance() {
  const B = 'https://fapi.binance.com';
  const S = 'BTCUSDT';
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
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const debug = new URL(request.url).searchParams.has('debug');

    // Fetch all three venues concurrently; Bybit is the required core.
    const [by, ok, bn] = await Promise.all([attempt(bybit), attempt(okx), attempt(binance)]);

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

    const d = {
      mark: core.mark, chg1h: core.chg1h, chg4h: core.chg4h, chg24h: core.chg24h,
      funding: core.funding, oiD1h: core.oiD1h, book: core.book, taker,
    };

    const payload = {
      ts: Date.now(),
      source: core.source + (bnv ? ' + Binance' : '') + (okv ? ' + OKX' : ''),
      price: { mark: core.mark, chg1h: core.chg1h, chg4h: core.chg4h, chg24h: core.chg24h },
      funding: { rate: core.funding, nextFundingTime: core.nextFundingTime },
      oi: { btc: core.oiBtc, usd: core.oiUsd, d1h: core.oiD1h, d4h: core.oiD4h, aggBtc, aggUsd: aggBtc * core.mark, venues },
      positioning: { taker, topLS, source: posSource },
      book: core.book,
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
