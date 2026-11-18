import { rsiZone } from '../worker/src/compute/rsi.js';
import { WATCHLIST } from './lists.js';

/**
 * Extended tab — coins at a 4H RSI(14) extreme, from the same /candidates
 * response (no fetch of its own). Information only: rows are not clickable and
 * nothing here grades a setup.
 *
 * Every row carries the 4H trend context, because RSI alone reads as a fade
 * prompt: "overbought" in an uptrend means late for the long, not short here.
 * Spec: docs/superpowers/specs/2026-11-18-extended-tab-design.md.
 */
const ZONE = { extreme_ob: 'extreme OB', ob: 'OB', os: 'OS', extreme_os: 'extreme OS' };

const CONTEXT = {
  with_trend: "with trend · late, don't chase",
  against_trend: 'against trend · needs 4H BOS',
  broken: '4H structure broken',
  unclear: 'trend unclear',
};

/**
 * with_trend    OB in an uptrend, OS in a downtrend: the trend is stretched.
 * against_trend OB in a downtrend, OS in an uptrend.
 * broken        price is through the protected point, so the side is stale.
 * unclear       no 4H structure to judge against.
 * null          RSI is not at an extreme.
 */
export function trendContext(item) {
  const zone = rsiZone(item?.rsi4h);
  if (!zone) return null;
  if (item.status === 'broken') return 'broken';
  if (item.side !== 'long' && item.side !== 'short') return 'unclear';
  const ob = zone === 'ob' || zone === 'extreme_ob';
  return (ob === (item.side === 'long')) ? 'with_trend' : 'against_trend';
}

export function extendedHtml(data, { watchlist = WATCHLIST, asOf = null } = {}) {
  if (!data || !Array.isArray(data.items)) {
    return '<p class="cand-empty">Extended unavailable.</p>';
  }
  if (data.items.length && !data.items.some((m) => Number.isFinite(m.rsi4h))) {
    return '<p class="cand-empty">RSI unavailable — the Worker returned none.</p>';
  }
  const banner = asOf ? `<p class="cand-asof">as of ${asOf} WIB</p>` : '';
  const rows = data.items
    .filter((m) => rsiZone(m.rsi4h))
    .sort((a, b) => Math.abs(b.rsi4h - 50) - Math.abs(a.rsi4h - 50));
  if (!rows.length) {
    return banner + '<p class="cand-empty">No coin at 4H RSI ≤ 30 or ≥ 70 right now.</p>';
  }
  const listed = new Set(watchlist);
  return banner + rows.map((m) => {
    const zone = rsiZone(m.rsi4h);
    const ctx = trendContext(m);
    return `
    <div class="cand-row">
      <span class="cand-base">${m.base}</span>
      <span class="ext-rsi">${m.rsi4h.toFixed(1)}</span>
      <span class="ext-zone z-${zone}">${ZONE[zone]}</span>
      <span class="ext-ctx c-${ctx}">${CONTEXT[ctx]}</span>
      ${listed.has(m.base) ? '' : '<span class="cand-off">off-list</span>'}
    </div>`;
  }).join('');
}

export function renderExtended(data, asOf = null) {
  document.getElementById('extended-list').innerHTML = extendedHtml(data, { asOf });
}
