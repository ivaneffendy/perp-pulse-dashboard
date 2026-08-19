import { fetchMatrix, fetchAsset, fetchMacro } from './api.js';
import { renderRow, sortRows } from './matrix.js';
import { renderDetail } from './detail.js';
import { renderWeather, initEtfToggle } from './weather.js';
import { enrichBinance } from './binance-enrich.js';

// Playbook §II's fixed eight. Override with ?watchlist=BTC,HYPE,... (persisted).
const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'NEAR', 'SUI', 'AVAX', 'LINK', 'ARB'];
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;

const params = new URLSearchParams(location.search);
if (params.get('watchlist')) {
  localStorage.setItem('ppd_watchlist', params.get('watchlist').toUpperCase());
}
const saved = (localStorage.getItem('ppd_watchlist') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const WATCHLIST = saved.length ? saved : DEFAULT_WATCHLIST;

const $ = (id) => document.getElementById(id);
let lastGood = 0;
let openSymbol = null;
let timer = null;

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

async function openDetail(symbol) {
  openSymbol = symbol;
  for (const r of $('matrix').children) {
    r.classList.toggle('open', r.dataset.symbol === symbol);
  }
  const node = $('detail');
  node.hidden = false;
  node.textContent = 'Loading…';
  try {
    const d = await fetchAsset(symbol, { deep: true, etf: etf.get() });
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

async function load() {
  const btn = $('refresh');
  btn.disabled = true;
  document.body.classList.add('updating');
  showError('');

  const matrix = $('matrix');
  const rows = new Map([...matrix.children].map((n) => [n.dataset.symbol, n]));
  let anyOk = false;

  const macroPromise = fetchMacro().catch(() => null);

  await fetchMatrix(WATCHLIST, { etf: etf.get() }, (base, res) => {
    if (res.ok) anyOk = true;
    const node = renderRow(base, res);
    if (base === openSymbol) node.classList.add('open');
    node.addEventListener('click', () => openDetail(base));
    const prev = rows.get(base);
    if (prev) prev.replaceWith(node); else matrix.appendChild(node);
    rows.set(base, node);
  });
  sortRows(matrix);

  const macro = await macroPromise;
  renderWeather(macro);
  etf.refresh(macro);

  if (anyOk) {
    lastGood = Date.now();
    $('ts').textContent = new Date().toLocaleTimeString();
    $('src').textContent = `${WATCHLIST.length} assets · Bybit core`;
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
  if (document.hidden) return;
  timer = setInterval(load, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  schedule();
  if (!document.hidden) load();
});
$('refresh').addEventListener('click', () => load());
setInterval(checkStale, 30_000);

load();
schedule();
