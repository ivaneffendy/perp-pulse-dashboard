import { fmtUsd, fmtPrice, fmtPct } from './format.js';
import { WATCHLIST } from './lists.js';

/**
 * Candidates pre-screen render. Rows are not clickable and nothing here grades
 * a setup — the chart read decides. `item.detail` is never put into the
 * markup: it can carry an exchange's raw response body.
 */
const LABEL = { in_zone: 'in zone', outside: 'outside', broken: 'broken', unclear: 'unclear', error: 'error' };

const age = (bars) => {
  const h = bars * 4;
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/**
 * Candidates cost ~21 exchange calls per fetch, so they load only when looked
 * at: once on opening the tab, again on a Refresh press while it is open, and
 * never from an automatic reload (the 5m timer, the ETF toggle, tab return).
 * @param {{trigger:'open'|'refresh'|'auto', activeTab:string, loaded:boolean, inFlight:boolean}} s
 */
export function shouldFetchCandidates({ trigger, activeTab, loaded, inFlight }) {
  if (inFlight) return false;
  if (trigger === 'open') return !loaded;
  if (trigger === 'refresh') return activeTab === 'candidates';
  return false;
}

export function candidatesHtml(data, { watchlist = WATCHLIST, asOf = null } = {}) {
  if (!data || !Array.isArray(data.items)) {
    return '<p class="cand-empty">Candidates unavailable.</p>';
  }
  const banner = (asOf ? `<p class="cand-asof">as of ${asOf} WIB</p>` : '')
    + (data.universeFiltered === false
      ? '<p class="cand-banner">⚠ unfiltered — may include non-crypto (XAU, CL)</p>'
      : '');
  if (!data.items.length) {
    return banner + '<p class="cand-empty">Nothing cleared the criterion right now.</p>';
  }
  const listed = new Set(watchlist);
  return banner + data.items.map((m) => {
    const ranged = m.status === 'in_zone' || m.status === 'outside';
    return `
    <div class="cand-row">
      <span class="cand-base">${m.base}</span>
      <span class="cand-side">${m.side ? m.side.toUpperCase() : '—'}</span>
      <span class="cand-status st-${m.status}">${LABEL[m.status] ?? 'unknown'}</span>
      ${ranged ? `<span class="cand-pct">${m.pctOfRange.toFixed(0)}%</span>` : ''}
      ${ranged ? `<span class="cand-prot">prot ${fmtPrice(m.protected)} (${fmtPct(m.distToProtectedPct, 1)})</span>` : ''}
      ${m.bosAgeBars != null ? `<span class="cand-bos">BOS ${age(m.bosAgeBars)}</span>` : ''}
      <span class="cand-vol">${fmtUsd(m.turnover24h)}</span>
      ${listed.has(m.base) ? '' : '<span class="cand-off">off-list</span>'}
    </div>`;
  }).join('');
}

export function renderCandidates(data, asOf = null) {
  document.getElementById('candidates-list').innerHTML = candidatesHtml(data, { asOf });
}
