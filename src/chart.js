import { WORKER_URL } from './api.js';
import { equilibrium } from '../worker/src/compute/equilibrium.js';
import { findFvgs, nearestUnmitigatedFvg } from '../worker/src/compute/fvg.js';
import { findOrderBlocks, nearestZone } from '../worker/src/compute/orderblock.js';
import { findSwings, findLiquidity } from '../worker/src/compute/liquidity.js';
import { marketMode } from '../worker/src/compute/mode.js';
import { VALID_BASE } from '../worker/src/pairs.js';
import { fmtPrice, fmtPct, signClass } from './format.js';

/**
 * Imports the Worker's own compute modules directly — they are pure functions
 * with no Workers-specific dependency, so this is one source of truth instead
 * of a second copy of the equilibrium/FVG/BOS logic to drift out of sync.
 */

const TIMEOUT_MS = 8000;

/**
 * Two different windows over the same fetch, deliberately not the same
 * number: equilibrium()/marketMode() already only ever look at their own
 * last 30 bars (5 days) no matter how much history is handed to them — that
 * is the playbook's own lookback, shared with the Worker's /asset payload.
 * FVG/OB/liquidity detection has no such built-in limit, though, and a zone —
 * or an untaken pool of stops — can sit there for longer than 5 days. So
 * COMPUTE_BARS fetches enough history for those three to still find an older,
 * still-relevant level, while only DISPLAY_BARS worth of candles are drawn —
 * bigger candles on screen without quietly shrinking what they can see.
 */
const COMPUTE_BARS = 90;
const DISPLAY_BARS = 30;

/**
 * Candles come through the WORKER, not straight from the device.
 *
 * The first version fetched OKX directly, on the reasoning that weather.js's
 * dominance call already does client-side fetching. That reasoning was wrong:
 * CoinGecko is not an exchange. Indonesian ISPs block the exchanges outright,
 * so `fetch('okx.com')` fails from the operator's own network exactly the way
 * Binance does — the constraint this Worker was built for in the first place.
 * Verified in production: the weather strip populated while every chart read
 * returned "Failed to fetch".
 *
 * Going through the Worker also fixes a real inconsistency for free: the chart
 * now shows whichever venue served the row, instead of always OKX.
 */
async function fetchBars(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = new URL(WORKER_URL);
    url.pathname = '/candles';
    url.searchParams.set('symbol', base);
    url.searchParams.set('limit', String(COMPUTE_BARS));
    const r = await fetch(url, { signal: ctrl.signal });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
    if (!d.bars?.length) throw new Error(`no 4H candles for ${base}`);
    if (d.bars.length < DISPLAY_BARS) throw new Error('too few closed 4H candles');
    return { bars: d.bars, source: d.source };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keyed by symbol, invalidated only by bumping `generation` — never by time.
 * Switching symbols or re-opening this tab reuses whatever the current
 * refresh cycle already fetched; pressing the main Refresh button is what
 * actually asks OKX again, exactly like Matrix's own data.
 */
const cache = new Map();
let generation = 0;
export function invalidateChartCache() { generation += 1; }

async function getBars(base) {
  const hit = cache.get(base);
  if (hit && hit.gen === generation) return hit.val;
  const val = await fetchBars(base);
  cache.set(base, { val, gen: generation });
  return val;
}

/**
 * Swing fractals + BOS position, purely for drawing the triangles/step-line.
 * The TREND/RANGE badge text below comes from the imported marketMode() —
 * this only reproduces its geometry so the chart has something to point at.
 */
function findSwingsAndBos(bars, lookback = 30, bosWithin = 6) {
  const win = bars.slice(-lookback);
  const winStart = bars.length - win.length;
  // The 2-bar fractal loop used to be written out here verbatim, a second
  // copy of mode.js's. liquidity.js owns the one definition now; only the BOS
  // half below is still local, because it exists purely to give the chart a
  // step-line to draw. (mode.js keeps its own copy deliberately — it feeds the
  // scored §VII TREND/RANGE read.)
  const { highs, lows } = findSwings(bars, lookback);
  if (win.length < 9) return { swingHighs: highs, swingLows: lows, bos: null };

  let lastBos = null;
  for (let i = 0; i < win.length; i++) {
    const bi = i + winStart; // findSwings indexes in bars space, so compare there
    let priorHigh = null, priorLow = null;
    for (const s of highs) if (s.i < bi) priorHigh = s;
    for (const s of lows)  if (s.i < bi) priorLow = s;
    if (priorHigh && win[i].c > priorHigh.p) lastBos = { i: bi, direction: 1, level: priorHigh.p };
    if (priorLow  && win[i].c < priorLow.p)  lastBos = { i: bi, direction: -1, level: priorLow.p };
  }
  const inWindow = lastBos && (bars.length - 1 - lastBos.i) <= bosWithin;
  return { swingHighs: highs, swingLows: lows, bos: inWindow ? lastBos : null };
}

/**
 * What actually reaches the rail. liquidity.js returns everything sorted
 * nearest-first and refuses to make this choice for us, so the phone-screen
 * budget is spent here:
 *   - both PD levels always — only two lines, and §III.1 Pillar 5 names them
 *   - the 4 nearest clusters, swept ones included: a raid that already
 *     happened is information, it just gets drawn hollow
 *   - the 4 nearest lone fractals, UNSWEPT ONLY — a taken single level is the
 *     weakest thing on the chart and purely noise
 */
const MAX_CLUSTERS = 4, MAX_FRACTALS = 4;
function selectPools(pools) {
  const take = (tier, n, keep = () => true) =>
    pools.filter((x) => x.tier === tier && keep(x)).slice(0, n);
  return [
    ...take('PD', 2),
    ...take('CLUSTER', MAX_CLUSTERS),
    ...take('FRACTAL', MAX_FRACTALS, (x) => !x.swept),
  ];
}

/** PDH/PDL · EQH/EQL (equal = clustered) · SWH/SWL (a lone swing). */
function poolName(p) {
  if (p.tier === 'PD') return p.side === 'high' ? 'PDH' : 'PDL';
  if (p.tier === 'CLUSTER') return p.side === 'high' ? 'EQH' : 'EQL';
  return p.side === 'high' ? 'SWH' : 'SWL';
}

/**
 * `bars` is the DISPLAY window only (see DISPLAY_BARS); `offset` is how many
 * earlier compute-only bars were sliced off, so an FVG/OB/swing/BOS index —
 * all computed against the wider COMPUTE_BARS array — maps to a display
 * column via `i - offset`. A zone whose origin bar is off-screen still gets
 * drawn (canvas clips it at the left edge on its own): that is the point —
 * it says "this zone is real, it just formed earlier than what's shown."
 */
function drawCandles(canvas, bars, { eq, fvg, fvgAll, obs, geo, price, offset, liq }) {
  const cssW = canvas.parentElement.clientWidth;
  const cssH = Math.max(300, Math.min(460, cssW * 0.75));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  /**
   * Liquidity gets its OWN gutter and never enters the candle field. A pool is
   * a price level; a price level needs to be readable against the price axis,
   * not to be smeared across 30 candles the way the zone layers are. When the
   * rail is toggled off it costs nothing — the space is not reserved.
   */
  const RAIL_W = liq.length ? 28 : 0;
  const RAIL_GAP = RAIL_W ? 6 : 0;
  const padL = 4, padR = 58 + RAIL_W + RAIL_GAP, padT = 12, padB = 20;
  const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
  const railX0 = padL + plotW + 3;
  const axisX = padL + plotW + RAIL_W + RAIL_GAP + 7; // price labels keep their 51px
  const n = bars.length;

  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  if (eq) { hi = Math.max(hi, eq.hh); lo = Math.min(lo, eq.ll); }
  const pad = (hi - lo || 1) * 0.06;
  hi += pad; lo -= pad;

  const xAt = (i) => padL + (plotW * (i + 0.5)) / n;
  // Compute-space index (FVG/OB/swings/BOS) -> display column.
  const xAtC = (i) => xAt(i - offset);
  const yAt = (p) => padT + plotH * (1 - (p - lo) / (hi - lo));
  const slot = plotW / n;
  const bw = Math.max(2, Math.min(9, slot * 0.62));

  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const cBorder = col('--border'), cMuted = col('--muted'), cText = col('--text');
  const cUp = col('--up'), cDown = col('--down'), cWarn = col('--warn'), cSteel = col('--steel');
  const mono = "'IBM Plex Mono',ui-monospace,monospace";
  // Canvas fillStyle takes plain CSS colors, not every browser resolves
  // color-mix() there — hand-roll the alpha blend from a #rrggbb token instead.
  const alpha = (hex, a) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  ctx.font = '10px ' + mono;
  ctx.textBaseline = 'middle';

  ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
  for (let t = 0; t <= 4; t++) {
    const p = lo + ((hi - lo) * t) / 4;
    const y = yAt(p);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillStyle = cMuted; ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(p), axisX, y);
  }

  if (eq) {
    const yEq = yAt(eq.eq), yHi = yAt(eq.hh), yLo = yAt(eq.ll);
    ctx.fillStyle = alpha(cWarn, 0.06);
    ctx.fillRect(padL, Math.max(padT, yHi), plotW, Math.max(0, yEq - Math.max(padT, yHi)));
    ctx.setLineDash([5, 4]); ctx.strokeStyle = cWarn; ctx.lineWidth = 1.2;
    [[eq.eq, 'EQ'], [eq.hh, '4H H'], [eq.ll, '4H L']].forEach(([p, label]) => {
      const y = yAt(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cWarn; ctx.textAlign = 'left'; ctx.font = '9px ' + mono;
      ctx.fillText(label, padL + 3, y - 7);
      ctx.font = '10px ' + mono; ctx.setLineDash([5, 4]);
    });
    ctx.setLineDash([]);
  }

  /**
   * Only the NEAREST zone — the one the badge below actually names — runs to
   * the right edge. Every other unmitigated FVG/OB used to do the same, and a
   * dozen translucent bands all terminating at the right edge turned the part
   * of the chart where price sits into unreadable mud. The rest now get a
   * short stub: still says "a zone formed here", stops smearing the tape.
   * The stub starts at the left edge for a zone whose origin is off-screen,
   * so an older zone does not silently vanish.
   */
  const STUB_BARS = 3;
  const stubEnd = (x0) => Math.max(x0, padL) + slot * STUB_BARS;

  for (const g of fvgAll) {
    const isNearest = fvg && g.index === fvg.index && g.type === fvg.type;
    const x0 = xAtC(g.index - 1) - slot * 0.5;
    const x1 = isNearest ? padL + plotW : stubEnd(x0);
    const yTop = yAt(g.top), yBot = yAt(g.bottom);
    const base = g.type === 'bull' ? cUp : cDown;
    ctx.fillStyle = alpha(base, isNearest ? 0.18 : 0.07);
    ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
    if (isNearest) { ctx.strokeStyle = base; ctx.lineWidth = 1; ctx.strokeRect(x0, yTop, x1 - x0, yBot - yTop); }
  }

  const obNearest = obs.nearest;
  for (const ob of obs.all) {
    const isNearest = obNearest && ob.index === obNearest.index && ob.type === obNearest.type;
    const x0 = xAtC(ob.index) - bw * 0.9;
    const x1 = isNearest ? padL + plotW : stubEnd(x0);
    const yTop = yAt(ob.top), yBot = yAt(ob.bottom);
    ctx.fillStyle = alpha(cSteel, isNearest ? 0.16 : 0.05);
    ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = alpha(cSteel, isNearest ? 0.9 : 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, yTop, x1 - x0, yBot - yTop);
    ctx.setLineDash([]);
    if (isNearest) {
      ctx.fillStyle = cSteel; ctx.font = '600 9px ' + mono; ctx.textAlign = 'left';
      ctx.fillText('OB', x0 + 3, yTop + 8);
    }
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i], x = xAt(i), up = b.c >= b.o;
    ctx.strokeStyle = up ? cUp : cDown; ctx.fillStyle = up ? cUp : cDown; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yAt(b.h)); ctx.lineTo(x, yAt(b.l)); ctx.stroke();
    const yo = yAt(b.o), yc = yAt(b.c);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }

  const tri = (x, y, up) => {
    ctx.fillStyle = cMuted;
    ctx.beginPath();
    if (up) { ctx.moveTo(x, y - 6); ctx.lineTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); }
    else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); }
    ctx.closePath(); ctx.fill();
  };
  // Swings/BOS come from geo, whose own lookback matches DISPLAY_BARS, so
  // these are always on-screen today — the bounds check just keeps that true
  // if the two numbers are ever tuned independently later.
  const onScreen = (i) => i - offset >= 0 && i - offset < n;
  for (const s of geo.swingHighs) if (onScreen(s.i)) tri(xAtC(s.i), yAt(s.p), true);
  for (const s of geo.swingLows) if (onScreen(s.i)) tri(xAtC(s.i), yAt(s.p), false);

  if (geo.bos && onScreen(geo.bos.i)) {
    const y = yAt(geo.bos.level), xStart = xAtC(geo.bos.i);
    ctx.setLineDash([2, 3]); ctx.strokeStyle = cSteel; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(xStart, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = cSteel; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xStart, y); ctx.lineTo(xStart, yAt(bars[geo.bos.i - offset].c)); ctx.stroke();
    ctx.fillStyle = cSteel; ctx.font = '600 9.5px ' + mono; ctx.textAlign = 'center';
    ctx.fillText('BOS', xStart, y + (geo.bos.direction > 0 ? -11 : 15));
  }

  const yPx = yAt(price);
  ctx.setLineDash([1, 3]); ctx.strokeStyle = cText + '66'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yPx); ctx.lineTo(padL + plotW, yPx); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cText;
  ctx.fillRect(axisX - 5, yPx - 7, cssW - axisX + 3, 14);
  ctx.fillStyle = col('--bg'); ctx.font = '600 10px ' + mono; ctx.textAlign = 'left';
  ctx.fillText(fmtPrice(price), axisX, yPx);

  /**
   * The liquidity rail. Tick LENGTH carries touch count (a stack of 4 equal
   * highs is visibly longer than a pair); FILLED = still resting, HOLLOW =
   * already swept. PD levels get an H/L glyph because §III.1 Pillar 5 names
   * them specifically. Nothing here is called "inducement" or "draw target" —
   * see liquidity.js for why that judgement is not the dashboard's to make.
   *
   * A pool outside the visible price scale is skipped rather than clamped to
   * an edge, which would put it at a price it is not at. The badge and the
   * copy line below still report it.
   */
  if (RAIL_W) {
    const cLiq = col('--liq');
    ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(railX0 - 2, padT); ctx.lineTo(railX0 - 2, padT + plotH); ctx.stroke();
    for (const pool of liq) {
      if (pool.level > hi || pool.level < lo) continue;
      const y = yAt(pool.level);
      const w = pool.tier === 'PD' ? 10
        : pool.tier === 'CLUSTER' ? Math.min(22, 8 + pool.touches * 4) : 6;
      ctx.globalAlpha = pool.swept ? 0.45 : 1;
      ctx.strokeStyle = cLiq; ctx.fillStyle = cLiq; ctx.lineWidth = 1;
      if (pool.swept) ctx.strokeRect(railX0 + 0.5, y - 1.5, w, 3);
      else ctx.fillRect(railX0, y - 1.5, w, 3);
      if (pool.tier === 'PD') {
        ctx.font = '600 8.5px ' + mono; ctx.textAlign = 'left';
        ctx.fillText(pool.side === 'high' ? 'H' : 'L', railX0 + w + 3, y);
      }
      ctx.globalAlpha = 1;
    }
    ctx.font = '10px ' + mono;
  }

  ctx.fillStyle = cMuted; ctx.font = '9.5px ' + mono;
  const fmtT = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', hour12: false });
  ctx.textAlign = 'left'; ctx.fillText(fmtT(bars[0].t), padL, cssH - 5);
  ctx.textAlign = 'right'; ctx.fillText(fmtT(bars[n - 1].t) + ' UTC', padL + plotW, cssH - 5);
}

/** Loading/error line. textContent, never innerHTML — the message can carry a
 *  ticker from localStorage or an upstream error string. */
function status(container, text, isErr = false) {
  container.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'chart-status' + (isErr ? ' chart-err' : '');
  p.textContent = text;
  container.appendChild(p);
}

/**
 * Renders the full chart body — price header, canvas, and the same
 * zone/FVG/mode badges the matrix row shows — for one symbol, into
 * `container`. Owns its own loading/error state so callers just call it.
 * `isCurrent` is re-checked after the await, so a stale response is dropped
 * rather than painted under another symbol's label.
 */
export async function renderChart(container, base, isCurrent = () => true) {
  // Never interpolate a symbol into markup or an upstream URL unmediated:
  // WATCHLIST can hold anything ?watchlist= or localStorage put there, and
  // CLAUDE.md makes this regex — not the PAIRS list — the thing that keeps
  // arbitrary strings out of upstream URLs.
  if (!VALID_BASE.test(base)) {
    status(container, `"${base}" is not a valid ticker.`, true);
    return;
  }
  status(container, `loading ${base} 4H candles…`);
  let computeBars, source;
  try {
    ({ bars: computeBars, source } = await getBars(base));
  } catch (e) {
    // Upstream text (OKX's own `msg`) reaches here, so it is set as text.
    if (isCurrent()) status(container, `${base}: ${e.message}`, true);
    return;
  }
  // A slow first fetch must never repaint over a chart the operator has since
  // switched to — same guard openDetail() uses for the detail panel.
  if (!isCurrent()) return;

  const price = computeBars[computeBars.length - 1].c;
  const prev = computeBars.length > 1 ? computeBars[computeBars.length - 2].c : price;
  const chg = (price / prev - 1) * 100;
  const eq = equilibrium(computeBars, price, 30);
  const fvgAll = findFvgs(computeBars).filter((g) => !g.mitigated);
  const fvg = nearestUnmitigatedFvg(computeBars, price);
  const obAll = findOrderBlocks(computeBars).filter((o) => !o.mitigated);
  const obNearest = nearestZone(obAll, price);
  const mode = marketMode(computeBars);
  const geo = findSwingsAndBos(computeBars);
  const liqAll = findLiquidity(computeBars, price).pools;
  const liqDrawn = selectPools(liqAll);
  // The badge names the nearest pool that is STILL THERE — a swept level is
  // not somewhere price is being drawn to any more.
  const liqNearest = liqAll.find((x) => !x.swept) || null;

  /**
   * The line the operator pastes into a chart read. It is built from
   * `liqDrawn`, not `liqAll`, on purpose: what gets recorded must be exactly
   * what was on screen when it was read, or the two stop being comparable.
   */
  const liqLine = [`LIQ 4H ${base}`, ...liqDrawn.map((x) =>
    `${poolName(x)} ${fmtPrice(x.level)}${x.touches > 1 ? ` x${x.touches}` : ''}`
    + ` ${x.swept ? 'swept' : 'unswept'} ${fmtPct(x.offsetPct)}`,
  )].join(' | ');

  // Private-mode / blocked-storage browsers must still render the chart.
  const LIQ_KEY = 'pp.chart.liq';
  let liqOn = true;
  try { liqOn = localStorage.getItem(LIQ_KEY) !== '0'; } catch { /* no storage */ }

  // Only the tail is actually drawn — see COMPUTE_BARS/DISPLAY_BARS above.
  const displayBars = computeBars.slice(-DISPLAY_BARS);
  const offset = computeBars.length - displayBars.length;

  container.innerHTML = `
    <div class="chart-head">
      <span class="chart-px">${fmtPrice(price)}</span>
      <span class="chart-chg ${signClass(chg)}">${fmtPct(chg)} 4H</span>
      <span class="chart-meta">last close · ${source} · ${displayBars.length} shown, ${computeBars.length} scanned</span>
    </div>
    <div class="chart-canvas-wrap"><canvas class="chart-canvas"></canvas></div>
    <div class="chart-badges">
      ${eq ? `<span class="badge">${eq.zone} · ${fmtPct(eq.pctToLow)} above 4H low (${fmtPrice(eq.ll)}–${fmtPrice(eq.hh)})</span>` : ''}
      <span class="badge">${fvg ? `${fvg.type === 'bull' ? 'Bull' : 'Bear'} FVG ${fvg.distPct.toFixed(2)}%` : "No-Man's Land"}</span>
      <span class="badge">${obNearest ? `${obNearest.type === 'bull' ? 'Bull' : 'Bear'} OB ${obNearest.distPct.toFixed(2)}%` : 'No OB nearby'}</span>
      <span class="badge liq">${liqNearest
        ? `${poolName(liqNearest)}${liqNearest.touches > 1 ? ` \u00d7${liqNearest.touches}` : ''} ${fmtPct(liqNearest.offsetPct)}`
        : 'No resting liquidity'}</span>
      <span class="badge ${mode.mode === 'TREND' ? (mode.direction > 0 ? 'pos' : 'neg') : ''}">
        ${mode.mode === 'TREND' ? `TREND ${mode.direction > 0 ? '↑' : '↓'}` : 'RANGE'}
      </span>
      <button type="button" class="badge liq-toggle" aria-pressed="true">LIQ rail</button>
    </div>
    <div class="chart-liq"><code class="chart-liq-line"></code><button type="button" class="chart-copy">Copy</button></div>
    <p class="chart-legend">Amber = the <b>rolling 30-bar</b> 4H high/low/EQ — a trailing 5-day extreme, <b>not</b> an anchored swing range, so it will not match a hand-drawn one · triangles = swing fractals · cyan step = the BOS driving TREND · green/red box = nearest unmitigated FVG · dashed steel box = order blocks (OB — provisional: unmitigated + at displacement origin, but it does <b>not</b> verify the move broke structure, and does not skip mid-range zones). Price is the last <b>closed</b> 4H bar, so it can differ from the Matrix row's live mark. Only the <b>nearest</b> FVG/OB runs to the right edge; the others are stubbed to 3 bars so they stop covering the tape, and FVG/OB are scanned over more history than is drawn, so a box can start off the left edge. Violet right-hand rail = <b>resting liquidity</b>: filled = still there, hollow = already swept, longer tick = more equal touches; <code>H</code>/<code>L</code> = previous UTC day high/low. It marks <b>where liquidity rests, not whether it is inducement or a draw target</b> \u2014 which one depends on your selected POI and direction, and the dashboard knows neither. Retail trendlines and session highs/lows are <b>not</b> detected (4H bars cannot resolve Asia/London/NY). A pool off the visible price scale is left out of the rail but still reported in the badge and the copy line. Candles come through the Worker, so the venue matches the row.</p>
  `;
  // Generated text, but set as textContent anyway — same rule the status()
  // helper follows, and it keeps `base` out of a markup path for good.
  container.querySelector('.chart-liq-line').textContent = liqLine;

  const canvas = container.querySelector('.chart-canvas');
  const liqBox = container.querySelector('.chart-liq');
  const toggle = container.querySelector('.liq-toggle');
  const paint = () => drawCandles(canvas, displayBars, {
    eq, fvg, fvgAll, obs: { all: obAll, nearest: obNearest }, geo, price, offset,
    liq: liqOn ? liqDrawn : [],
  });
  const syncLiq = () => {
    toggle.classList.toggle('on', liqOn);
    toggle.setAttribute('aria-pressed', String(liqOn));
    liqBox.hidden = !liqOn;
    paint();
  };
  toggle.addEventListener('click', () => {
    liqOn = !liqOn;
    try { localStorage.setItem(LIQ_KEY, liqOn ? '1' : '0'); } catch { /* no storage */ }
    syncLiq();
  });

  const copy = container.querySelector('.chart-copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(liqLine);
      copy.textContent = 'Copied';
    } catch {
      // Insecure context or a denied permission — select it so the operator
      // can copy by hand rather than being told nothing happened.
      const r = document.createRange();
      r.selectNodeContents(container.querySelector('.chart-liq-line'));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
      copy.textContent = 'Select + copy';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
  });

  syncLiq();
}
