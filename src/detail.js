import { fmtPct, fmtPrice, fmtCoin, fmtUsd, countdown } from './format.js';
import { scoreChips } from './matrix.js';

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

  const m = el('div', 'block');
  m.append(el('div', 'label', 'Market'));
  const g = el('div', 'grid');
  g.append(
    stat('Funding', d.funding.rate.toFixed(4) + '%',
      `annualized ~${(d.funding.rate * 3 * 365).toFixed(1)}%`),
    stat('Next funding', countdown(d.funding.nextFundingTime)),
    stat('Open interest', fmtCoin(d.oi.aggCoin ?? d.oi.coin) + ' ' + d.symbol,
      fmtUsd(d.oi.aggUsd ?? d.oi.usd)),
    stat('OI Δ 1h / 4h', `${fmtPct(d.oi.d1h)} / ${fmtPct(d.oi.d4h)}`),
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
