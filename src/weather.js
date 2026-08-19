import { fmtUsd } from './format.js';

/**
 * Dominance is fetched FROM THE DEVICE, not through the Worker.
 *
 * Every free market-cap API rate-limits by IP, and Cloudflare's Worker egress
 * IPs are shared across all Workers customers — so the quota is exhausted by
 * strangers before we ever call. CoinGecko returns 429 that way and CoinPaprika
 * returns 402, while both answer 200 from an ordinary connection. Same failure,
 * two vendors; swapping vendors does not fix it.
 *
 * The browser has the user's own IP, so it just works — the same hybrid trick
 * used for Binance in binance-enrich.js. This is only safe because dominance is
 * DISPLAY-ONLY and never enters the §VII score; anything scored must stay
 * server-side so there is exactly one source of truth.
 */
const DOM_TIMEOUT = 4000;

async function jt(url, ms = DOM_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function fetchDominance() {
  // CoinGecko first: one call, and it reports the percentages directly.
  try {
    const g = await jt('https://api.coingecko.com/api/v3/global');
    const d = g?.data, pct = d?.market_cap_percentage;
    const total = d?.total_market_cap?.usd;
    const btc = +pct?.btc, eth = +pct?.eth;
    if (Number.isFinite(total) && Number.isFinite(btc) && Number.isFinite(eth)) {
      return {
        btcD: btc,
        usdtD: Number.isFinite(+pct.usdt) ? +pct.usdt : null,
        total3: (total * (100 - btc - eth)) / 100,
        source: 'CoinGecko',
      };
    }
  } catch { /* fall through to the backup vendor */ }

  // CoinPaprika backup: two calls, raw market caps (more precise at scale).
  try {
    const [g, t] = await Promise.all([
      jt('https://api.coinpaprika.com/v1/global'),
      jt('https://api.coinpaprika.com/v1/tickers?limit=6'),
    ]);
    const total = g?.market_cap_usd;
    const mc = (sym) => t?.find?.((x) => x?.symbol === sym)?.quotes?.USD?.market_cap;
    const btc = mc('BTC'), eth = mc('ETH'), usdt = mc('USDT');
    if (Number.isFinite(total) && total > 0 && Number.isFinite(btc) && Number.isFinite(eth)) {
      return {
        btcD: (btc / total) * 100,
        usdtD: Number.isFinite(usdt) ? (usdt / total) * 100 : null,
        total3: total - btc - eth,
        source: 'CoinPaprika',
      };
    }
  } catch { /* both vendors unreachable — render em-dashes */ }

  return null;
}

/**
 * Display-only macro context. Dominance MUST NOT enter the §VII score — the
 * PRD is explicit and the scoring table has no dominance row. Styled muted
 * (dashed border, no traffic lights) so it never reads as a signal.
 *
 * `dom` is the device-fetched reading; `macro` is the Worker's attempt, kept as
 * a fallback for when the device itself cannot reach either vendor.
 */
export function renderWeather(macro, dom) {
  const d = dom ?? macro;
  const set = (id, v, title) => {
    const n = document.getElementById(id);
    n.textContent = v;
    if (title) n.title = title;
  };
  const src = dom?.source ? `via ${dom.source}, from this device` : 'via the data proxy';
  set('w-btcd', d?.btcD == null ? '—' : d.btcD.toFixed(1) + '%', src);
  set('w-usdtd', d?.usdtD == null ? '—' : d.usdtD.toFixed(2) + '%', src);
  set('w-total3', d?.total3 == null ? '—' : fmtUsd(d.total3), src);
}

const CYCLE = [null, 'in', 'out', 'flat'];
const LABEL = { in: 'ETF IN', out: 'ETF OUT', flat: 'ETF FLAT' };

/**
 * ETF flow is score layer 1 and its feed is dead: Farside sits behind a
 * Cloudflare bot challenge (403), so the auto value is almost always null.
 * This toggle is therefore the PRIMARY way the layer gets a value. The choice
 * is sent BACK to the Worker as ?etf=, so scoring still happens server-side in
 * one place rather than being duplicated into the page.
 */
export function initEtfToggle(onChange) {
  const btn = document.getElementById('etf-toggle');
  let manual = localStorage.getItem('ppd_etf') || null;

  const paint = (auto) => {
    btn.classList.toggle('manual', !!manual);
    if (manual) {
      btn.textContent = LABEL[manual];
      btn.title = 'Manual override — tap to cycle (in → out → flat → auto)';
      return;
    }
    btn.textContent = auto == null ? 'ETF —' : 'ETF ' + fmtUsd(auto);
    btn.title = auto == null
      ? 'No ETF feed available (Farside is bot-blocked). Tap to set it manually.'
      : 'Auto ETF net flow. Tap to override.';
  };

  btn.addEventListener('click', () => {
    manual = CYCLE[(CYCLE.indexOf(manual) + 1) % CYCLE.length];
    if (manual) localStorage.setItem('ppd_etf', manual);
    else localStorage.removeItem('ppd_etf');
    paint(null);
    onChange();
  });

  paint(null);
  return {
    get: () => manual,
    refresh: (macro) => paint(macro?.etfBtc ?? null),
  };
}
