import { fmtUsd } from './format.js';

/**
 * Display-only macro context. Dominance MUST NOT enter the §VII score — the
 * PRD is explicit and the scoring table has no dominance row. Styled muted
 * (dashed border, no traffic lights) so it never reads as a signal.
 */
export function renderWeather(macro) {
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('w-btcd', macro?.btcD == null ? '—' : macro.btcD.toFixed(1) + '%');
  set('w-usdtd', macro?.usdtD == null ? '—' : macro.usdtD.toFixed(2) + '%');
  set('w-total3', macro?.total3 == null ? '—' : fmtUsd(macro.total3));
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
