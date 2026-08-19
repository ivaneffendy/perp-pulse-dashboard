/**
 * Macro layer: CoinGecko dominance (display only) + spot ETF flows (score
 * layer 1).
 *
 * Dominance MUST NOT enter the score — the PRD is explicit about this and the
 * §VII table has no dominance row.
 *
 * ETF flow is the flakiest input in the whole system: Farside is HTML, has no
 * CORS headers and is scraper-hostile. Everything here returns null rather than
 * throwing, and score.js treats null as a neutral 0.
 */

const CG = 'https://api.coingecko.com/api/v3/global';
const FARSIDE = 'https://farside.co.uk/bitcoin-etf-flow-all-data/';

export function parseDominance(payload) {
  const d = payload?.data;
  const total = d?.total_market_cap?.usd;
  const pct = d?.market_cap_percentage;
  if (!Number.isFinite(total) || !pct) return null;
  const btcD = +pct.btc, ethD = +pct.eth, usdtD = +pct.usdt;
  if (!Number.isFinite(btcD) || !Number.isFinite(ethD)) return null;
  return {
    btcD, usdtD, totalMcap: total,
    total3: total * (100 - btcD - ethD) / 100,
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
    if (!Number.isFinite(n)) return null;
    return (neg ? -n : n) * 1e6; // $m -> $
  }
  return null;
}

export async function fetchMacro(j) {
  const [dom, etf] = await Promise.all([
    j(CG).then(parseDominance).catch(() => null),
    j(FARSIDE, { text: true }).then(parseFarsideTotal).catch(() => null),
  ]);
  return {
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
