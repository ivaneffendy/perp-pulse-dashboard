import { fmtPct, fmtPrice, fmtCoin, fmtUsd, countdown, zoneConflict } from './format.js';
import { scoreChips } from './matrix.js';
import { fetchLtf } from './api.js';

// Freshness IS the feature here: the button exists so the read is from the
// moment it is looked at. Past this, the block greys and asks to be re-pressed
// rather than sitting there looking current.
const LTF_STALE_MS = 2 * 60 * 1000;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const stat = (k, v, sub) => {
  const s = el('div', 'stat');
  s.append(el('div', 'k', k), el('div', 'v', v));
  if (sub) s.append(el('div', 'k', sub));
  return s;
};

/** Which venues the aggregate OI actually spans — it is a sum, not one reading. */
const venueList = (venues) => (venues
  ? Object.entries(venues).filter(([, v]) => v != null).map(([k]) => k).join(' + ')
  : '');

/**
 * Phase 2, §IV Step 2 — "is this tap being absorbed, or sliced through?"
 *
 * A THIRD question, separate from both the §VII bias above it and the 1-hour
 * pullback health beside it. Rendered in its own labelled block for the same
 * reason those two are: they answer different questions and must never be read
 * as one verdict.
 */
function ltfBlock(symbol) {
  const wrap = el('div', 'block');
  wrap.append(el('div', 'label', 'LTF trigger (§IV Step 2)'));

  const btn = el('button', 'ghost ltf-btn', 'Check 15m trigger');
  const out = el('div', 'ltf-out');
  let staleTimer = null;

  const reset = () => {
    clearTimeout(staleTimer);
    btn.disabled = false;
    btn.textContent = 'Check 15m trigger';
  };

  btn.addEventListener('click', async () => {
    clearTimeout(staleTimer);
    btn.disabled = true;
    btn.textContent = 'Checking…';
    out.className = 'ltf-out';
    out.textContent = '';
    try {
      const r = await fetchLtf(symbol);
      out.className = 'ltf-out ' + r.cls;
      out.append(
        el('div', 'ltf-head', r.label),
        el('p', null, r.msg),
        el('div', 'ltf-meta', [
          r.rvol == null ? null : `${r.rvol.toFixed(1)}x avg volume`,
          `via ${r.source}`,
          new Date(r.ts).toLocaleTimeString(),
        ].filter(Boolean).join(' · ')),
      );
      // Grey out once the read is no longer current, so an old verdict cannot
      // be mistaken for a live one.
      staleTimer = setTimeout(() => {
        out.classList.add('ltf-stale');
        out.append(el('div', 'ltf-meta', 'This read is over 2 minutes old — check again.'));
      }, LTF_STALE_MS);
    } catch (e) {
      out.className = 'ltf-out err';
      out.textContent = `Could not read the 15m trigger: ${e.message}`;
    } finally {
      reset();
    }
  });

  wrap.append(btn, out);
  return wrap;
}

export function renderDetail(node, d, onClose) {
  node.innerHTML = '';
  node.hidden = false;

  const close = el('button', 'close', 'close ✕');
  close.addEventListener('click', onClose);
  node.append(close, el('h2', null, `${d.symbol} · ${fmtPrice(d.price.mark)}`));

  // BLOCK 1 — Phase 1 bias. Labelled with the question it answers, because it
  // can legitimately disagree with the health block below.
  const bias = el('div', 'block');
  bias.append(el('div', 'label',
    `Bias (§VII) — ${d.score.verdict} ${d.score.total >= 0 ? '+' : ''}${d.score.total}`));
  const eq = d.signals?.equilibrium;
  if (eq) {
    bias.append(el('p', null, `${eq.zone} · ${eq.pctOfRange.toFixed(0)}% of range`));
  }
  const conflict = zoneConflict(d.score.cls, eq);
  if (conflict) {
    const w = el('span', 'zone-warn', `⚠ ${conflict}`);
    w.title = conflict === 'premium'
      ? 'CLEAR TO LONG, but price is in Premium (§III pillar 2 wants Discount for longs)'
      : 'CLEAR TO SHORT, but price is in Discount (§III pillar 2 wants Premium for shorts)';
    bias.append(w);
  }
  bias.append(scoreChips(d.score.layers));
  node.append(bias);

  // BLOCK 2 — Phase 2 health. NEVER summed with the bias score above: on
  // price-down + OI-down these two deliberately disagree.
  if (d.health) {
    const h = el('div', 'block health ' + d.health.cls);
    h.append(el('div', 'label', 'Pullback health — absorption or a knife?'));
    h.append(el('p', null, d.health.msg));
    node.append(h);
  }

  // Sits directly below health: same Phase 2 moment, finer timeframe. Fetched
  // only on press, so opening this panel never costs the 15m call.
  node.append(ltfBlock(d.symbol));

  const m = el('div', 'block');
  // Which venue actually served this row. Bybit is primary and OKX is the
  // fallback, so the two are NOT interchangeable — funding, OI and the candles
  // every signal is derived from all differ between them.
  m.append(el('div', 'label', d.source ? `Market · via ${d.source}` : 'Market'));
  const g = el('div', 'grid');
  g.append(
    stat('Funding', d.funding.rate.toFixed(4) + '%',
      `annualized ~${(d.funding.rate * 3 * 365).toFixed(1)}%`),
    stat('Next funding', countdown(d.funding.nextFundingTime)),
    stat('Open interest', fmtCoin(d.oi.aggCoin ?? d.oi.coin) + ' ' + d.symbol,
      [fmtUsd(d.oi.aggUsd ?? d.oi.usd), venueList(d.oi.venues)].filter(Boolean).join(' · ')),
    // OI can come from OKX even when the core row came from Bybit — Bybit's OI
    // endpoint geo-fails on its own. This is the value score layer 3 reads.
    stat('OI Δ 1h / 4h', `${fmtPct(d.oi.d1h)} / ${fmtPct(d.oi.d4h)}`, d.oi.source ?? ''),
    stat('Taker buy/sell',
      d.positioning?.taker == null ? 'n/a' : d.positioning.taker.toFixed(3), '1h aggressor flow'),
    stat('Long / short',
      d.positioning?.topLS == null ? 'n/a' : d.positioning.topLS.toFixed(3),
      d.positioning?.source ?? ''),
  );
  m.append(g);
  node.append(m);

  if (d.book) {
    const b = el('div', 'block');
    const cov = Math.max(d.book.ask.coveredPct || 0, d.book.bid.coveredPct || 0);
    b.append(el('div', 'label',
      `Order-book walls · ±${cov.toFixed(2)}% · ${d.book.source ?? ''}`));
    const side = (name, s) => {
      const w = s.nearestWall;
      return el('p', null, w
        ? `${name}: ${fmtPrice(w.price)} (${fmtPct(w.distPct)}) · ${fmtCoin(w.size)} ${d.symbol}`
        : `${name}: smooth — no distinct wall`);
    };
    b.append(
      side('Ask', d.book.ask), side('Bid', d.book.bid),
      el('p', null, `Resting ${Math.round(d.book.imbalancePct)}% bid / ${100 - Math.round(d.book.imbalancePct)}% ask`),
    );
    node.append(b);
  }
}
