import { fmtPct, fmtPrice, fmtScore, signClass, zoneConflict } from './format.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** The five §VII layers, always shown together — a total alone isn't actionable. */
export function scoreChips(layers) {
  const box = el('div', 'chips');
  for (const l of layers) {
    const c = el('span', 'chip ' + signClass(l.value));
    c.textContent = `${l.label} ${fmtScore(l.value)}`;
    c.title = l.detail;
    if (l.proxy) {
      const p = el('span', 'pxy', 'proxy');
      p.title = 'BTC ETF flow used as a macro proxy — not asset-specific';
      c.appendChild(p);
    }
    box.appendChild(c);
  }
  return box;
}

export function renderRow(base, result) {
  const row = el('div', 'row');
  row.dataset.symbol = base;

  if (!result.ok) {
    // One dead venue degrades ONE row. The rest of the grid still paints.
    row.classList.add('err');
    row.dataset.score = '0';
    const top = el('div', 'row-top');
    top.append(el('span', 'tkr', base), el('span', 'vd', result.err));
    row.append(top);
    return row;
  }

  const d = result.data;
  const s = d.score;
  row.classList.add(s.cls);
  row.dataset.score = String(Math.abs(s.total));

  const eq = d.signals.equilibrium;
  const conflict = zoneConflict(s.cls, eq);

  const top = el('div', 'row-top');
  top.append(
    el('span', 'tkr', base),
    el('span', 'score ' + signClass(s.total), fmtScore(s.total)),
    el('span', 'vd', s.verdict),
  );
  if (conflict) {
    const w = el('span', 'zone-warn', `⚠ ${conflict}`);
    w.title = conflict === 'premium'
      ? 'CLEAR TO LONG, but price is in Premium (§III pillar 2 wants Discount for longs)'
      : 'CLEAR TO SHORT, but price is in Discount (§III pillar 2 wants Premium for shorts)';
    top.append(w);
  }
  const px = el('span', 'px');
  px.append(
    document.createTextNode(fmtPrice(d.price.mark) + ' '),
    el('span', signClass(d.price.chg1h), fmtPct(d.price.chg1h)),
  );
  top.append(px);

  const mid = el('div', 'row-mid');
  mid.append(
    el('span', null, eq ? `${eq.zone} · ${fmtPct(eq.pctToLow)} above 4H low` : 'no range data'),
    el('span', signClass(d.oi.d1h), `OI ${d.oi.d1h >= 0 ? '↑' : '↓'} ${fmtPct(d.oi.d1h)}`),
    // Negative funding is the bullish side, so invert the colour.
    el('span', signClass(-d.funding.rate), `Fund ${d.funding.rate >= 0 ? '↑' : '↓'} ${d.funding.rate.toFixed(4)}%`),
  );

  const bot = el('div', 'row-bot');
  const f = d.signals.fvg;
  bot.append(el('span', 'badge', f
    ? `${f.type === 'bull' ? 'Bull' : 'Bear'} FVG ${f.distPct.toFixed(2)}%`
    : 'No-Man’s Land'));
  bot.append(el('span', 'badge', d.signals.mode.mode === 'TREND'
    ? `TREND ${d.signals.mode.direction > 0 ? '↑' : '↓'}` : 'RANGE'));
  if (d.signals.sweep.layer !== 0 || d.signals.sweep.label === 'both swept') {
    bot.append(el('span', 'badge hot', d.signals.sweep.label));
  }
  // Unscored OI quadrants are surfaced here rather than moving the score.
  const oiDetail = s.layers.find((l) => l.key === 'oi').detail;
  if (oiDetail === 'fresh shorts' || oiDetail === 'short covering') {
    bot.append(el('span', 'badge hot', oiDetail));
  }

  row.append(top, mid, bot, scoreChips(s.layers));
  return row;
}

/** Extremes float to the top; CHOPPY sinks. That is the radar's whole job. */
export function sortRows(container) {
  [...container.children]
    .sort((a, b) => (+b.dataset.score || 0) - (+a.dataset.score || 0))
    .forEach((n) => container.appendChild(n));
}
