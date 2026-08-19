/**
 * PRD §4C / playbook §VI — TREND vs RANGE.
 *
 * Swing points via a 2-bar fractal; a BOS is a BODY CLOSE beyond the most recent
 * prior swing. If the last BOS is recent we are expanding (TREND); otherwise we
 * are oscillating (RANGE), which per §VI forbids runners entirely.
 */
export function marketMode(bars, { lookback = 30, bosWithin = 6 } = {}) {
  const win = bars.slice(-lookback);
  if (win.length < 9) return { mode: 'RANGE', direction: 0 };

  const highs = [], lows = [];
  for (let i = 2; i < win.length - 2; i++) {
    const { h, l } = win[i];
    if (h > win[i-1].h && h > win[i-2].h && h > win[i+1].h && h > win[i+2].h) highs.push({ i, p: h });
    if (l < win[i-1].l && l < win[i-2].l && l < win[i+1].l && l < win[i+2].l) lows.push({ i, p: l });
  }

  let lastBos = null;
  for (let i = 0; i < win.length; i++) {
    let priorHigh = null, priorLow = null;
    for (const s of highs) if (s.i < i) priorHigh = s;
    for (const s of lows)  if (s.i < i) priorLow = s;
    if (priorHigh && win[i].c > priorHigh.p) lastBos = { i, direction: 1 };
    if (priorLow  && win[i].c < priorLow.p)  lastBos = { i, direction: -1 };
  }

  if (lastBos && (win.length - 1 - lastBos.i) <= bosWithin) {
    return { mode: 'TREND', direction: lastBos.direction };
  }
  return { mode: 'RANGE', direction: 0 };
}
