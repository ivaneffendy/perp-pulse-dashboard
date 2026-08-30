/**
 * MFE/MAE backfill for the trade journal — playbook revision R11.
 *
 * Answers one question: on the losing trades, did price ever move in favour?
 *   most losses MFE < 0.5R   -> direction was wrong        -> R1 regime gate
 *   most losses MFE > 1.5R   -> direction was right, swept -> §IV Step 6 buffer
 * These have opposite remedies, so the bucket distribution at the end of this
 * run is the actual deliverable.
 *
 * Code lives here because its dependency does (worker/src/compute/klines.js).
 * Data lives in trading-vault. Nothing crosses: both paths are CLI arguments.
 *
 *   node scripts/backfill_mfe.js \
 *     --journal   ../trading-vault/journal/trade-log-v1.csv \
 *     --overrides ../trading-vault/journal/r-distance-overrides.json \
 *     --out       ../trading-vault/journal/mfe-backfill.csv
 *
 * Every path is an argument. This repo is public and the journal is not, so no
 * trade prices, position sizes or risk figures belong anywhere in this file —
 * including its comments and its tests. The input CSV is opened read-only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { normalizeKlines, INTERVAL_15M } from '../worker/src/compute/klines.js';
import { resolvePair } from '../worker/src/pairs.js';
import { UPSTREAM_HEADERS } from '../worker/src/index.js';

/**
 * Journal timestamps are WIB (UTC+7), not UTC. Established against the tape, not
 * assumed: on two independent trades the logged stop-out time matches a bar that
 * actually traded through the stop only after seven hours are subtracted. Read
 * as UTC, every window lands seven hours late and every number below is
 * silently wrong while still looking plausible.
 */
const JOURNAL_UTC_OFFSET_HOURS = 7;

/**
 * OKX is the default venue because api.bybit.com does not resolve from an
 * Indonesian ISP — it and fapi.binance.com both answer 203.119.13.76, the
 * national block address. Bybit stays selectable for runs from an edge that
 * can reach it. OKX candle rows are [ts, o, h, l, c, ...], the same field
 * order as Bybit, so normalizeKlines consumes either unchanged.
 */
const VENUES = {
  okx: {
    label: 'OKX SWAP',
    maxBars: 100,
    instrument: (sym) => sym.okxInst,
    exists: async (sym) => {
      const r = await getJson(
        `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${sym.okxInst}`);
      return (r.data ?? []).length > 0;
    },
    // `after` returns bars strictly OLDER than the timestamp, newest-first.
    page: async (sym, beforeMs, limit) => {
      const r = await getJson('https://www.okx.com/api/v5/market/history-candles'
        + `?instId=${sym.okxInst}&bar=15m&after=${beforeMs}&limit=${limit}`);
      return r.data ?? [];
    },
  },
  bybit: {
    label: 'Bybit linear',
    maxBars: 1000,
    instrument: (sym) => sym.bybit,
    exists: async (sym) => {
      const r = await getJson(
        `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${sym.bybit}`);
      return (r.result?.list ?? []).length > 0;
    },
    page: async (sym, beforeMs, limit) => {
      const r = await getJson('https://api.bybit.com/v5/market/kline'
        + `?category=linear&symbol=${sym.bybit}&interval=15&end=${beforeMs}&limit=${limit}`);
      return r.result?.list ?? [];
    },
  },
};

/**
 * 1R repairs, supplied as data via --overrides. The table is journal content and
 * lives in the journal repo; this file only knows the shape.
 *
 * Why it is needed: trailing a stop overwrote a column in the journal export,
 * and — the part that cannot be detected from inside the data — it was a
 * DIFFERENT column on different rows. On some rows the recorded stop is the
 * trailed value rather than the initial one, so |entry - sl| understates 1R. On
 * others the recorded risk is wrong but the stop price survived, and no repair
 * is needed at all.
 *
 * Where a row is listed, 1R is rebuilt from the initial dollar risk instead:
 *   r_distance = initialRiskUsd * entry / notional
 *
 * Left unrepaired, an affected row's mfe_R comes out several times too large and
 * lands in the wrong bucket — the one number this script exists to produce.
 */
function loadOverrides(path) {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed.overrides ?? {};
}

const MAX_FORWARD_SCAN_DAYS = 30;   // cap on inferring an unlogged exit
const RATE_LIMIT_MS = 120;          // OKX history-candles allows 20 req / 2s

// ---------------------------------------------------------------- http

async function getJson(url, attempt = 0) {
  const res = await fetch(url, { headers: UPSTREAM_HEADERS });
  if (!res.ok) {
    // 429 and 5xx are worth retrying; a 400 means the request itself is wrong.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(500 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

/**
 * Ascending 15m bars covering [fromMs, toMs], paged backwards from the end
 * because both venues page that direction.
 */
async function fetchRange(venue, sym, fromMs, toMs) {
  // Floor to the bar that CONTAINS the fill. A fill at 10:07 sits inside the
  // 10:00 bar, and an exclusive `>= fromMs` drops that bar entirely — which
  // silently deleted the entry bar from every window, produced a negative MFE on
  // one trade, and returned nothing at all for a short trade that opened and
  // closed inside a single bar.
  const from = floorBar(fromMs);
  const out = new Map();
  let cursor = toMs + INTERVAL_15M;
  for (;;) {
    const raw = await venue.page(sym, cursor, venue.maxBars);
    await sleep(RATE_LIMIT_MS);
    const bars = normalizeKlines(raw, INTERVAL_15M, Date.now());
    if (!bars.length) break;
    for (const b of bars) if (b.t >= from && b.t <= toMs) out.set(b.t, b);
    const oldest = bars[0].t;
    if (oldest <= from) break;
    if (cursor === oldest) break;              // venue stopped paging
    cursor = oldest;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- csv

/** RFC4180 enough for a Sheets export: quoted fields with embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() ?? []).map(clean);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, clean(r[i] ?? '')])));
}

/**
 * Sheets pastes directional-formatting marks into date cells (U+200E appears on
 * 22 of the 28 rows). They are invisible in every viewer and make Date.parse
 * return NaN, so strip them before anything else touches the value.
 */
const clean = (s) => String(s ?? '')
  .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00A0]/g, '')
  .trim();

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------------------------------------------------------------- time

/**
 * Three formats coexist in the journal, all of them WIB:
 *   28-05-2026            date only  (trades 1-5)
 *   05-06-2026 16:10      DD-MM      (trades 6-10)
 *   2026-06-12 21:45:07   ISO-ish    (trades 11+)
 * Returns { ms, hasTime } or null.
 */
function parseWib(raw) {
  const s = clean(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return wib(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), Boolean(m[4]));
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return wib(+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), Boolean(m[4]));
  return null;
}

const wib = (y, mo, d, h, mi, se, hasTime) => ({
  ms: Date.UTC(y, mo - 1, d, h - JOURNAL_UTC_OFFSET_HOURS, mi, se),
  hasTime,
});

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const floorBar = (ms) => Math.floor(ms / INTERVAL_15M) * INTERVAL_15M;
const touches = (bar, price) => bar.l <= price && price <= bar.h;

// ---------------------------------------------------------------- per trade

async function resolveWindow(venue, sym, trade, prevEntryMs, now) {
  const { entryTs: entry, closeTs: close } = trade;

  // Both logged with a clock: use them directly.
  if (entry?.hasTime && close?.hasTime) {
    return { fill: entry.ms, exit: close.ms, source: 'logged' };
  }

  // Otherwise the fill is the first 15m bar whose range touches the entry
  // price. Bounded by the logged day when there is one; for the open trade,
  // which carries no date at all, by the previous trade's entry.
  const scanFrom = entry ? entry.ms : prevEntryMs;
  if (!Number.isFinite(scanFrom)) throw new Error('no entry date and no previous trade to anchor from');
  const dayEnd = entry ? scanFrom + 24 * 60 * 60 * 1000 : scanFrom + MAX_FORWARD_SCAN_DAYS * 864e5;

  const openingBars = await fetchRange(venue, sym, floorBar(scanFrom), Math.min(dayEnd, now));
  const fillBar = openingBars.find((b) => touches(b, trade.entryPrice));
  if (!fillBar) throw new Error(`no 15m bar touched entry ${trade.entryPrice} in the search window`);
  const fill = fillBar.t;

  // Open position: it has no exit, so the window runs to now.
  if (trade.isOpen) return { fill, exit: now, source: 'inferred' };

  // Closed but no close time: walk forward to the first touch of the stop.
  if (close?.hasTime) return { fill, exit: close.ms, source: 'inferred' };
  const horizon = Math.min(fill + MAX_FORWARD_SCAN_DAYS * 864e5, now);
  const forward = await fetchRange(venue, sym, fill, horizon);
  const exitBar = forward.find((b) => b.t > fill && touches(b, trade.initialSl));
  if (!exitBar) throw new Error(`stop ${trade.initialSl} not touched within ${MAX_FORWARD_SCAN_DAYS}d of fill`);
  return { fill, exit: exitBar.t + INTERVAL_15M, source: 'inferred' };
}

function excursions(bars, trade, rDistance) {
  const isLong = trade.direction === 'long';
  let best = null, worst = null, barsToMfe = 0;
  bars.forEach((b, i) => {
    const fav = isLong ? b.h : b.l;
    const adv = isLong ? b.l : b.h;
    if (best === null || (isLong ? fav > best : fav < best)) { best = fav; barsToMfe = i; }
    if (worst === null || (isLong ? adv < worst : adv > worst)) worst = adv;
  });
  const sign = isLong ? 1 : -1;
  return {
    mfe_R: (sign * (best - trade.entryPrice)) / rDistance,
    mae_R: (sign * (trade.entryPrice - worst)) / rDistance,
    bars_to_mfe: barsToMfe,
  };
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const out = { venue: 'okx' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k) out[k] = argv[i + 1];
  }
  if (!out.journal || !out.out) {
    console.error('usage: node scripts/backfill_mfe.js --journal <in.csv> --out <out.csv>'
      + ' [--overrides <r-distance-overrides.json>] [--venue okx|bybit]');
    process.exit(2);
  }
  if (!VENUES[out.venue]) { console.error(`unknown venue: ${out.venue}`); process.exit(2); }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const venue = VENUES[args.venue];
  const overrides = loadOverrides(args.overrides);
  const now = Date.now();

  const trades = parseCsv(readFileSync(args.journal, 'utf8'))
    .filter((r) => /^\d+$/.test(r['Trade ID']) && r['Entry Price'])
    .map((r) => ({
      id: +r['Trade ID'],
      base: r.Pair.toUpperCase(),
      direction: r.Direction.toLowerCase(),
      entryPrice: +r['Entry Price'],
      initialSl: +r['Initial SL Price'],
      notional: +r['Position Size'],
      result: r.Result || 'Open',
      isOpen: !r.Result,
      entryTs: parseWib(r['Entry Date']),
      closeTs: parseWib(r['Close Date']),
    }));

  const nOver = Object.keys(overrides).length;
  console.error(`${trades.length} trades · venue ${venue.label} · journal clock UTC+${JOURNAL_UTC_OFFSET_HOURS}`
    + ` · ${nOver} r_distance override(s)${nOver ? '' : ' — pass --overrides if the journal has repairs'}\n`);

  const rows = [];
  let prevEntryMs = null;

  for (const t of trades) {
    const sym = resolvePair(t.base);
    const label = `#${String(t.id).padStart(2)} ${t.base.padEnd(6)}`;
    try {
      if (!sym) throw new Error(`unresolvable symbol ${t.base}`);
      if (!(await venue.exists(sym))) {
        // A coin the venue never listed is expected, not exceptional.
        console.error(`${label} SKIP — not listed on ${venue.label}`);
        rows.push({ trade_id: t.id, pair: t.base, direction: t.direction, note: `not listed on ${venue.label}` });
        continue;
      }

      const override = overrides[t.id];
      const rDistance = override
        ? (override.initialRiskUsd * t.entryPrice) / t.notional
        : Math.abs(t.entryPrice - t.initialSl);
      if (!(rDistance > 0)) throw new Error('r_distance is zero or unusable');

      const win = await resolveWindow(venue, sym, t, prevEntryMs, now);
      const bars = await fetchRange(venue, sym, win.fill, win.exit);
      if (!bars.length) throw new Error('venue returned no bars for the window');

      const ex = excursions(bars, t, rDistance);
      const holdHours = (win.exit - win.fill) / 36e5;
      rows.push({
        trade_id: t.id,
        pair: t.base,
        direction: t.direction,
        fill_ts: iso(win.fill),
        exit_ts: iso(win.exit),
        ts_source: win.source,
        r_distance: round(rDistance, 6),
        mfe_R: round(ex.mfe_R, 3),
        mae_R: round(ex.mae_R, 3),
        hit_1R: ex.mfe_R >= 1,
        hit_2R: ex.mfe_R >= 2,
        bars_to_mfe: ex.bars_to_mfe,
        hold_hours: round(holdHours, 2),
        result: t.result,
        note: override ? `r_distance override: ${override.why}` : '',
      });
      console.error(`${label} ${win.source.padEnd(8)} mfe ${fmt(ex.mfe_R)}R  mae ${fmt(ex.mae_R)}R`
        + `  ${bars.length} bars  ${holdHours.toFixed(1)}h${override ? '  [r_distance override]' : ''}`);
    } catch (err) {
      // One unrecoverable trade must not cost the other 27.
      console.error(`${label} FAILED — ${err.message}`);
      rows.push({ trade_id: t.id, pair: t.base, direction: t.direction, note: `failed: ${err.message}` });
    } finally {
      if (t.entryTs) prevEntryMs = t.entryTs.ms;
    }
  }

  const header = ['trade_id', 'pair', 'direction', 'fill_ts', 'exit_ts', 'ts_source', 'r_distance',
    'mfe_R', 'mae_R', 'hit_1R', 'hit_2R', 'bars_to_mfe', 'hold_hours', 'result', 'note'];
  writeFileSync(args.out,
    [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n');

  summarise(rows, args.out);
}

const round = (n, d) => Number(n.toFixed(d));
const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);

/** The point of the run: where the losses' favourable excursion actually sits. */
function summarise(rows, outPath) {
  const losses = rows.filter((r) => r.result === 'Loss' && Number.isFinite(r.mfe_R));
  const buckets = [
    ['< 0.5R  (never moved in favour -> R1, wrong direction)', (v) => v < 0.5],
    ['0.5-1R  (moved, never paid)', (v) => v >= 0.5 && v < 1],
    ['1-1.5R  (moved, no TP1)', (v) => v >= 1 && v < 1.5],
    ['> 1.5R  (right, then swept -> §IV Step 6, SL buffer)', (v) => v >= 1.5],
  ];

  console.error(`\nwrote ${outPath}`);
  console.error(`\nmfe_R distribution — ${losses.length} trades with Result = Loss\n`);
  for (const [label, test] of buckets) {
    const hit = losses.filter((r) => test(r.mfe_R));
    const pct = losses.length ? Math.round((hit.length / losses.length) * 100) : 0;
    console.error(`  ${label.padEnd(52)} ${String(hit.length).padStart(2)}  ${'#'.repeat(hit.length).padEnd(22)} ${pct}%`);
  }
  const skipped = rows.filter((r) => r.note && !Number.isFinite(r.mfe_R));
  if (skipped.length) {
    console.error(`\n${skipped.length} trade(s) produced no numbers:`);
    for (const r of skipped) console.error(`  #${r.trade_id} ${r.pair} — ${r.note}`);
  }
}

// Importable for tests; runs only when invoked as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { parseCsv, parseWib, clean, excursions, resolveWindow, fetchRange, VENUES, loadOverrides, iso };
