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

/**
 * Pin and remove live on the row, which is itself clickable, so both stop
 * propagation — a mis-tap that opened the detail panel instead of removing a
 * coin would be maddening on a phone.
 */
function rowControls({ pinned, canPin = true, onPin, onRemove }) {
  const box = el('span', 'row-ctl');
  const pin = el('button', 'pin-btn', '+ pin');
  pin.title = 'Keep this coin on the watchlist';
  // Nothing to pin if the coin does not resolve to real data.
  pin.hidden = pinned || !canPin;
  pin.addEventListener('click', (e) => { e.stopPropagation(); onPin(); });

  const rm = el('button', 'rm-btn', '✕');
  rm.title = 'Remove from the watchlist';
  rm.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });

  box.append(pin, rm);
  return box;
}

export function renderRow(base, result, ctl = null) {
  const row = el('div', 'row');
  row.dataset.symbol = base;
  if (ctl && !ctl.pinned) row.classList.add('temp');

  if (!result.ok) {
    // One dead venue degrades ONE row — and so does a coin that simply does not
    // list on either venue. The rest of the grid still paints.
    row.classList.add('err');
    row.dataset.score = '0';
    const top = el('div', 'row-top');
    top.append(el('span', 'tkr', base), el('span', 'vd', result.err));
    if (ctl) top.append(rowControls({ ...ctl, canPin: false }));
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
  if (ctl) top.append(rowControls(ctl));

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
  // Bybit is primary. A row served by the OKX fallback was scored off a
  // different venue's candles, funding and OI, so the swap must be visible —
  // silently passing it off as the usual source is how you size a position on
  // numbers you think you recognise.
  if (d.source && !d.source.startsWith('Bybit')) {
    const v = el('span', 'badge src-alt', `via ${d.source.split(' ')[0]}`);
    v.title = `Bybit was unreachable for ${base} — price, funding, OI and every `
      + `kline-derived signal came from ${d.source} instead.`;
    bot.append(v);
  }
  if (d.oi.source === 'unavailable') {
    const v = el('span', 'badge src-alt', 'OI n/a');
    v.title = 'Neither venue returned open interest — score layer 3 has nothing to read.';
    bot.append(v);
  }
  // Resolved and answered, but its venue coverage was never verified the way
  // the §II set was, so say so rather than implying equal footing.
  if (d.known === false) {
    const v = el('span', 'badge src-alt', 'unverified');
    v.title = `${base} is outside the checked pair list — it resolved and the venue `
      + 'answered, but coverage and symbol mapping were never confirmed for it.';
    bot.append(v);
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
