import { fmtUsd, fmtPct, signClass } from './format.js';

/**
 * Awareness-only: no click handler, no score, no verdict. Plain rows so this
 * can never be mistaken for a Phase 1/2 read on an off-list coin. `data` is
 * null on a failed fetch — see main.js's load(), which catches the same way
 * it already does for fetchMacro/fetchDominance.
 */
export function renderMovers(data) {
  const el = document.getElementById('movers-list');
  if (!data) {
    el.innerHTML = '<p class="movers-empty">Movers unavailable.</p>';
    return;
  }
  if (!data.items.length) {
    el.innerHTML = '<p class="movers-empty">Nothing cleared the volume floor right now.</p>';
    return;
  }
  el.innerHTML = data.items.map((m) => `
    <div class="mover-row">
      <span class="mv-base">${m.base}</span>
      <span class="mv-pct ${signClass(m.pct24h)}">${fmtPct(m.pct24h, 1)}</span>
      <span class="mv-rel ${signClass(m.rel)}">${m.rel >= 0 ? '+' : ''}${m.rel.toFixed(1)}pp vs BTC</span>
      <span class="mv-vol">${fmtUsd(m.turnover24h)}</span>
    </div>`).join('');
}
