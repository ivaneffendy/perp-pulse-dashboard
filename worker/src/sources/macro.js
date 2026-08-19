/**
 * Macro layer: CoinGecko dominance (display only) + spot ETF flows (score
 * layer 1).
 *
 * Dominance MUST NOT enter the score — the PRD is explicit about this and the
 * §VII table has no dominance row.
 *
 * ETF flow is the flakiest input in the whole system. CONFIRMED 2026-08-19:
 * Farside returns HTTP 403 behind a Cloudflare bot challenge ("Just a
 * moment..."), so the scrape yields nothing and layer 1 sits at 0. The parser
 * is kept and unit-tested so that if a readable feed ever appears the wiring
 * is already correct — but in practice the header's manual in/out/flat toggle
 * is the PRIMARY way this layer gets a value, not a fallback.
 *
 * Everything here returns null rather than throwing; score.js treats null as 0.
 */

// CoinGecko's free tier rate-limits by IP, and Cloudflare's egress IPs are
// shared across every Workers customer, so /api/v3/global answers 429
// permanently from here. CoinPaprika needs no key and is not IP-starved.
const CP_GLOBAL = 'https://api.coinpaprika.com/v1/global';
const CP_TICKERS = 'https://api.coinpaprika.com/v1/tickers?limit=6';
const FARSIDE = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';

/**
 * TOTAL3 is total market cap excluding BTC and ETH. Computed from raw market
 * caps rather than rounded dominance percentages, which lose precision at the
 * trillion scale.
 */
export function parseDominance(global, tickers) {
  const total = global?.market_cap_usd;
  if (!Number.isFinite(total) || total <= 0 || !Array.isArray(tickers)) return null;
  const mcap = (sym) => tickers.find((t) => t?.symbol === sym)?.quotes?.USD?.market_cap;
  const btc = mcap('BTC'), eth = mcap('ETH'), usdt = mcap('USDT');
  if (!Number.isFinite(btc) || !Number.isFinite(eth)) return null;
  return {
    btcD: (btc / total) * 100,
    ethD: (eth / total) * 100,
    usdtD: Number.isFinite(usdt) ? (usdt / total) * 100 : null,
    totalMcap: total,
    total3: total - btc - eth,
  };
}

/**
 * Farside renders one row per day with the net total in the last cell, in $m,
 * using accounting parentheses for negatives. We take the last DATED row.
 */
export function parseFarsideTotal(html) {
  if (typeof html !== 'string' || !html) return null;
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const cells = (rows[i].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (!cells.length) continue;
    if (!/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(cells[0])) continue; // dated rows only
    const raw = cells[cells.length - 1];
    const neg = /^\(.*\)$/.test(raw);
    const n = parseFloat(raw.replace(/[(),$]/g, ''));
    // Today's row often exists before its figure is published ('-' or blank).
    // Keep walking up to the last day that actually has a number, rather than
    // reporting a placeholder as a real zero-flow day.
    if (!Number.isFinite(n)) continue;
    return (neg ? -n : n) * 1e6; // $m -> $
  }
  return null;
}

export async function fetchMacro(j) {
  // allSettled, not catch(()=>null): swallowing the reason is exactly how a
  // CoinGecko 403 hid behind an empty weather widget for a whole deploy.
  // Reasons are surfaced on /macro?debug=1.
  const settled = await Promise.allSettled([
    Promise.all([j(CP_GLOBAL), j(CP_TICKERS)]).then(([g, t]) => parseDominance(g, t)),
    j(FARSIDE, { text: true }).then(parseFarsideTotal),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);
  const why = (r, v) => r.status === 'rejected'
    ? String(r.reason?.message ?? r.reason)
    : (v == null ? 'fetched ok but parsed to null' : null);
  const dom = val(settled[0]), etf = val(settled[1]);
  return {
    errors: { dominance: why(settled[0], dom), etf: why(settled[1], etf) },
    btcD: dom?.btcD ?? null,
    usdtD: dom?.usdtD ?? null,
    total3: dom?.total3 ?? null,
    totalMcap: dom?.totalMcap ?? null,
    // ETH spot ETF has no equivalent free feed; left null so score.js neutralises
    // the layer for ETH rather than misreporting BTC flow as ETH flow.
    etfBtc: etf,
    etfEth: null,
    etfAsOf: etf == null ? null : Date.now(),
  };
}
