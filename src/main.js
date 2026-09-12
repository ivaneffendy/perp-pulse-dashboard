import { fetchMatrix, fetchAsset, fetchMacro, fetchMovers } from './api.js';
import { renderRow, sortRows } from './matrix.js';
import { renderDetail } from './detail.js';
import { renderWeather, initEtfToggle, fetchDominance } from './weather.js';
import { enrichBinance } from './binance-enrich.js';
import { renderMovers } from './movers.js';
import { fetchTop100Bases } from './marketcap.js';
import { renderChart, invalidateChartCache } from './chart.js';
import { VALID_BASE } from '../worker/src/pairs.js';

/**
 * Deliberately defined here rather than exported from format.js. This page
 * has no build step and GitHub Pages serves every module with
 * `cache-control: max-age=600` and no content hash, so for ten minutes after
 * a deploy a browser can pair a FRESH main.js with a CACHED format.js. A new
 * cross-module export is the one change that turns that mismatch into a
 * module SyntaxError, which aborts the whole graph and takes the entire
 * dashboard down — not just the clock. Adding no new import contract keeps
 * that impossible.
 */
const fmtWib = (ts) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(ts);

// Always-on anchors; the rest of playbook §II is one lookup away, not pre-loaded.
// Override with ?watchlist=BTC,HYPE,... (persisted).
const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL'];
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
// Returning to the tab must NOT trigger a full fetch every time. Each refresh
// is 8 asset requests = ~32 upstream exchange calls, so switching back and
// forth while reading was a burst generator — and bursts are exactly what trips
// Bybit's geo-block and OKX's rate limit. Only refetch if data is older than
// this; otherwise what is already on screen is perfectly current.
const MIN_REFETCH_MS = 60 * 1000;

const params = new URLSearchParams(location.search);
if (params.get('watchlist')) {
  localStorage.setItem('ppd_watchlist', params.get('watchlist').toUpperCase());
}
// Auto-refresh can be turned off entirely with ?auto=off (persisted). Manual
// mode still refreshes when you press the button, and still warns when stale.
if (params.get('auto')) localStorage.setItem('ppd_auto', params.get('auto').toLowerCase());
const AUTO = (localStorage.getItem('ppd_auto') || 'off') !== 'off';

// Filtered on the way IN, not at each use site: `?watchlist=` is persisted to
// localStorage verbatim (only uppercased), so without this a crafted link puts
// arbitrary strings into WATCHLIST — which then reach a `[data-symbol="..."]`
// selector, an upstream URL, and the chart's own DOM.
const readSaved = () => (localStorage.getItem('ppd_watchlist') || '')
  .split(',').map((s) => s.trim()).filter((s) => VALID_BASE.test(s));

// Mutable now that coins can be pinned and removed from the page itself.
let WATCHLIST = readSaved().length ? readSaved() : [...DEFAULT_WATCHLIST];

/**
 * Looked-up coins that have NOT been pinned. Held in memory only: they survive
 * a Refresh so a lookup is not lost mid-scan, but not a page reload — an
 * unpinned coin is a question being asked, not part of the watchlist.
 */
const temp = new Set();

const symbols = () => [...WATCHLIST, ...[...temp].filter((s) => !WATCHLIST.includes(s))];

function saveWatchlist() {
  localStorage.setItem('ppd_watchlist', WATCHLIST.join(','));
}

const $ = (id) => document.getElementById(id);
let lastGood = 0;
let openSymbol = null;
let timer = null;
let activeTab = 'matrix';
let chartSymbol = null;
/**
 * A typed-in chart-only lookup, separate from WATCHLIST/temp: viewing a
 * chart should not add a scored Matrix row or spend a Worker call, only
 * OKX's own candle fetch (see chart.js).
 */
let chartExtra = null;
const chartSymbols = () => (chartExtra && !symbols().includes(chartExtra)
  ? [chartExtra, ...symbols()] : symbols());
// Resolved ETF flow for score layer 1: the manual toggle if set, else whatever
// /macro returned. Fetched ONCE per refresh and relayed to every /asset call —
// eight assets each pulling macro themselves is a stampede that rate-limits the
// upstream (CoinPaprika 402).
let etfValue = null;

const etf = initEtfToggle(() => load());

function showError(msg) {
  $('err').hidden = !msg;
  $('err').textContent = msg || '';
}

/**
 * Showing 40-minute-old prices as if they were live is the worst failure this
 * tool can have — you would size a position off a number that no longer
 * exists. So staleness is loud and the grid dims.
 */
function checkStale() {
  const age = Date.now() - lastGood;
  const stale = lastGood > 0 && age > STALE_MS;
  $('stale').hidden = !stale;
  document.body.classList.toggle('stale-data', stale);
  if (stale) {
    $('stale').textContent =
      `Data is ${Math.floor(age / 60000)} min old — the last refresh failed. Do not trade off these numbers.`;
  }
}

function closeDetail() {
  openSymbol = null;
  $('detail').hidden = true;
  $('detail').innerHTML = '';
  for (const r of $('matrix').children) r.classList.remove('open');
}

/**
 * Pure visibility toggle between Matrix, Movers and Chart. Deliberately does
 * not fetch anything on its own for Matrix/Movers — both ride the normal
 * Refresh cadence (see load()), and a fetch-on-switch would undermine the
 * "manual refresh only" contract the rest of this file enforces for every
 * other data source. Chart is the one exception: it is fetched on-demand
 * (see renderChartTab) because pre-loading candles for a symbol nobody is
 * looking at would just burn OKX calls for nothing.
 */
function selectTab(name) {
  activeTab = name;
  $('view-matrix').hidden = name !== 'matrix';
  $('view-movers').hidden = name !== 'movers';
  $('view-chart').hidden = name !== 'chart';
  $('tab-matrix').classList.toggle('active', name === 'matrix');
  $('tab-movers').classList.toggle('active', name === 'movers');
  $('tab-chart').classList.toggle('active', name === 'chart');
  $('tab-matrix').setAttribute('aria-selected', String(name === 'matrix'));
  $('tab-movers').setAttribute('aria-selected', String(name === 'movers'));
  $('tab-chart').setAttribute('aria-selected', String(name === 'chart'));
  if (name === 'chart') renderChartTab();
}

/** Draw `base`, dropping the result if the selection moved on mid-fetch. */
function drawChart(base) {
  renderChart($('chart-body'), base, () => chartSymbol === base && activeTab === 'chart');
}

/** Symbol picker + chart body for whichever coin is currently selected. */
function renderChartPicker() {
  const box = $('chart-syms');
  box.innerHTML = '';
  const pinned = symbols();
  for (const base of chartSymbols()) {
    const btn = document.createElement('button');
    btn.className = 'chart-sym-btn'
      + (base === chartSymbol ? ' active' : '')
      // Dashed only for a lookup that is genuinely not on the watchlist —
      // typing a ticker that IS pinned must not make its button look temporary.
      + (base === chartExtra && !pinned.includes(base) ? ' temp' : '');
    btn.textContent = base;
    btn.addEventListener('click', () => {
      if (base === chartSymbol) return;
      chartSymbol = base;
      renderChartPicker();
      drawChart(base);
    });
    box.appendChild(btn);
  }
}

function renderChartTab() {
  const list = chartSymbols();
  if (!list.length) return;
  if (!chartSymbol || !list.includes(chartSymbol)) chartSymbol = list[0];
  renderChartPicker();
  drawChart(chartSymbol);
}

/** Typed-in chart-only lookup — validates and swaps the chart, nothing else. */
function lookupChart(raw) {
  const base = String(raw || '').trim().toUpperCase();
  if (!VALID_BASE.test(base)) {
    showError(`"${raw}" is not a valid ticker — 2-15 letters or digits, e.g. PEPE.`);
    return;
  }
  showError('');
  chartExtra = base;
  chartSymbol = base;
  renderChartPicker();
  drawChart(base);
}

async function openDetail(symbol) {
  openSymbol = symbol;
  for (const r of $('matrix').children) {
    r.classList.toggle('open', r.dataset.symbol === symbol);
  }
  const node = $('detail');
  node.hidden = false;
  node.textContent = 'Loading…';
  try {
    const d = await fetchAsset(symbol, { deep: true, etf: etfValue });
    if (openSymbol !== symbol) return;
    renderDetail(node, d, closeDetail);
    // Non-blocking: enrich from the user's own network if it can reach Binance.
    if (await enrichBinance(d, () => openSymbol === symbol)) {
      renderDetail(node, d, closeDetail);
    }
  } catch (e) {
    if (openSymbol !== symbol) return;
    node.textContent = `Could not load ${symbol}: ${e.message}`;
  }
}

/**
 * One row, wired with its controls. Pin/remove sit on the row itself, so both
 * must stop propagation — the row's own click opens the detail panel, and a
 * mis-tap that opened a panel instead of removing a coin would be maddening on
 * a phone.
 */
function paintRow(base, res) {
  const pinned = WATCHLIST.includes(base);
  const node = renderRow(base, res, {
    pinned,
    onPin: () => {
      WATCHLIST.push(base);
      temp.delete(base);
      saveWatchlist();
      repaint();
    },
    onRemove: () => {
      WATCHLIST = WATCHLIST.filter((s) => s !== base);
      temp.delete(base);
      saveWatchlist();
      $('matrix').querySelector(`[data-symbol="${base}"]`)?.remove();
      if (openSymbol === base) closeDetail();
      repaint();
    },
  });
  if (base === openSymbol) node.classList.add('open');
  node.addEventListener('click', () => openDetail(base));
  return node;
}

/** Re-label rows in place after a pin/remove, without refetching anything. */
function repaint() {
  for (const node of [...$('matrix').children]) {
    const base = node.dataset.symbol;
    node.classList.toggle('temp', !WATCHLIST.includes(base));
    const pin = node.querySelector('.pin-btn');
    // An errored row has nothing worth pinning, so leave its pin hidden.
    if (pin && !node.classList.contains('err')) pin.hidden = WATCHLIST.includes(base);
  }
  const extra = temp.size ? ` · ${temp.size} unpinned` : '';
  $('src').textContent =
    `${WATCHLIST.length} assets${extra} · ${AUTO ? 'auto 5m' : 'manual only'}`;
  if (activeTab === 'chart') renderChartTab();
}

/** Look up a typed coin and drop it in as an unpinned row. */
async function lookup(raw) {
  const base = String(raw || '').trim().toUpperCase();
  const input = $('wl-input');
  if (!VALID_BASE.test(base)) {
    showError(`"${raw}" is not a valid ticker — 2-15 letters or digits, e.g. PEPE.`);
    return;
  }
  if (WATCHLIST.includes(base) || temp.has(base)) {
    input.value = '';
    $('matrix').querySelector(`[data-symbol="${base}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  showError('');
  input.disabled = true;
  temp.add(base);
  try {
    const res = await fetchAsset(base, { etf: etfValue })
      .then((data) => ({ ok: true, data }), (e) => ({ ok: false, err: e.message }));
    // A coin that does not list simply fails its own row, exactly like a dead
    // venue does — it never blanks the grid.
    const node = paintRow(base, res);
    const prev = $('matrix').querySelector(`[data-symbol="${base}"]`);
    if (prev) prev.replaceWith(node); else $('matrix').prepend(node);
    input.value = '';
  } finally {
    input.disabled = false;
    repaint();
  }
}

async function load() {
  // Fired independently, not awaited: nothing downstream needs this before
  // the matrix can start, and /movers being slow must never delay Phase 1.
  // The market-cap allowlist is fetched from this device (see marketcap.js,
  // same reason as dominance) and relayed into /movers as ?top100= — a
  // failed/uncached lookup resolves to null, which just leaves the Worker's
  // whole-market ranking in place instead of blanking the tab.
  fetchTop100Bases().catch(() => null)
    .then(fetchMovers)
    .then(renderMovers, () => renderMovers(null));

  // Chart candles are cached by symbol (see chart.js) so switching symbols or
  // re-opening the tab never re-asks OKX — only a real Refresh press does.
  // Only the symbol actually on screen is re-fetched; the rest of the
  // watchlist's candles are never pulled until someone looks at them.
  invalidateChartCache();
  if (activeTab === 'chart') renderChartTab();

  const btn = $('refresh');
  btn.disabled = true;
  document.body.classList.add('updating');
  showError('');

  const matrix = $('matrix');
  const rows = new Map([...matrix.children].map((n) => [n.dataset.symbol, n]));
  let anyOk = false;

  // Macro first, so its ETF number can be relayed to every asset request.
  // Dominance rides alongside but comes from THIS DEVICE — see weather.js.
  const [macro, dom] = await Promise.all([
    fetchMacro().catch(() => null),
    fetchDominance().catch(() => null),
  ]);
  renderWeather(macro, dom);
  etf.refresh(macro);
  const manual = etf.get();
  etfValue = manual != null ? manual : (macro?.etfBtc ?? null);

  const wanted = symbols();
  // Rows for coins no longer on the list must go, or a removal only takes
  // effect after a reload.
  for (const [base, node] of rows) {
    if (!wanted.includes(base)) { node.remove(); rows.delete(base); }
  }

  await fetchMatrix(wanted, { etf: etfValue }, (base, res) => {
    if (res.ok) anyOk = true;
    const node = paintRow(base, res);
    const prev = rows.get(base);
    if (prev) prev.replaceWith(node); else matrix.appendChild(node);
    rows.set(base, node);
  });
  sortRows(matrix);

  if (anyOk) {
    lastGood = Date.now();
    $('ts').textContent = new Date().toLocaleTimeString();
    // Top-of-page and explicit WIB, not the device's own locale — so a
    // screenshot means the same thing later, whichever screen took it.
    $('w-wib').textContent = fmtWib(lastGood);
    const extra = temp.size ? ` · ${temp.size} unpinned` : '';
    $('src').textContent =
      `${WATCHLIST.length} assets${extra} · ${AUTO ? 'auto 5m' : 'manual only'}`;
  } else {
    showError('Could not reach the data proxy. Set it once with ?api=<worker-url>.');
  }

  checkStale();
  btn.disabled = false;
  document.body.classList.remove('updating');
}

function schedule() {
  clearInterval(timer);
  // §II says the charts are closed most of the day — a hidden tab should not
  // burn request quota or phone battery.
  if (!AUTO || document.hidden) return;
  timer = setInterval(load, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  schedule();
  // In manual mode (the default), returning to the tab must never trigger a
  // fetch on its own — only the Refresh button may.
  if (document.hidden || !AUTO) return;
  // Refetch on return ONLY if what is on screen has actually gone stale.
  if (Date.now() - lastGood > MIN_REFETCH_MS) load();
});
$('refresh').addEventListener('click', () => load());
// Canvas pixel dimensions are set at draw time from the container's current
// width, so an orientation flip or a resize needs a redraw — from cache, no
// refetch — or the chart keeps whatever size it was first drawn at. Debounced:
// a window drag fires this dozens of times a second and each pass rebuilds the
// chart DOM and re-runs the FVG/OB scans.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (activeTab === 'chart' && chartSymbol) drawChart(chartSymbol);
  }, 150);
});
$('tab-matrix').addEventListener('click', () => selectTab('matrix'));
$('tab-movers').addEventListener('click', () => selectTab('movers'));
$('tab-chart').addEventListener('click', () => selectTab('chart'));

$('wl-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lookup(e.target.value);
});
$('chart-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  lookupChart(e.target.value);
  e.target.value = '';
});
$('wl-reset').addEventListener('click', () => {
  WATCHLIST = [...DEFAULT_WATCHLIST];
  temp.clear();
  chartExtra = null;
  saveWatchlist();
  closeDetail();
  $('matrix').innerHTML = '';
  showError('');
  repaint();
});

setInterval(checkStale, 30_000);

// Manual mode is the default: the very first fetch, like every fetch after
// it, must come from the user pressing Refresh — not from script boot.
if (AUTO) load();
else $('src').textContent = 'Press Refresh to load data';
schedule();
