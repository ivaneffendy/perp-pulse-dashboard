/**
 * §IV Step 6 counterfactual — playbook revision R11b.
 *
 * The test R11 structurally could not run. mfe_R is measured over [fill, exit]
 * and `exit` IS the stop-out, so a trade that is swept at -1R and then reverses
 * records mfe_R ~ 0 and is filed under "wrong direction". This walks PAST the
 * stop instead, and asks the question §IV Step 6 actually poses:
 *
 *   with the stop b% wider, would the trade have survived — and then paid?
 *
 * Sizing note that decides how this is scored. Under §I,
 * `size = (equity x risk%) / |entry - sl|`, so a wider stop SHRINKS the position
 * and a loss still costs exactly 1R. Widening does not enlarge losses. What it
 * does is stretch R in price terms, pushing TP1 (1:2 RR) further away. TP1 is
 * therefore recomputed against the widened R. The original 2R price level is
 * reported alongside it, because the gap between the two IS the cost.
 *
 *   node scripts/backfill_sl_counterfactual.js \
 *     --journal   ../trading-vault/journal/trade-log-v1.csv \
 *     --overrides ../trading-vault/journal/r-distance-overrides.json \
 *     --out       ../trading-vault/journal/sl-counterfactual.csv
 *
 * This repo is public and the journal is not: no trade prices, position sizes or
 * risk figures belong in this file, its comments, or its tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolvePair } from '../worker/src/pairs.js';
import { INTERVAL_15M } from '../worker/src/compute/klines.js';
import {
  parseCsv, parseWib, resolveWindow, fetchRange, VENUES, loadOverrides, iso,
} from './backfill_mfe.js';

const DEFAULT_BUFFERS = [0.3, 0.5, 1.0];   // percent of price, as §IV Step 6 states it
const DEFAULT_HORIZON_H = 48;

/**
 * Walk the extended window bar by bar and return whichever comes first.
 *
 * Within a single bar the order of the high and the low is unknowable from OHLC,
 * so a bar that touches both the stop and the target counts as STOPPED. That is
 * the conservative read and it biases against the buffer, which is the correct
 * direction to be wrong in when the whole point is deciding whether to widen.
 */
function race(bars, { isLong, stop, target }) {
  for (const b of bars) {
    const hitStop = isLong ? b.l <= stop : b.h >= stop;
    const hitTarget = isLong ? b.h >= target : b.l <= target;
    if (hitStop) return { outcome: 'stopped', at: b.t };
    if (hitTarget) return { outcome: 'tp1', at: b.t };
  }
  return { outcome: 'open_at_horizon', at: null };
}

const touched = (bars, { isLong, price }) =>
  bars.some((b) => (isLong ? b.h >= price : b.l <= price));

function parseArgs(argv) {
  const out = { venue: 'okx', buffers: DEFAULT_BUFFERS.join(','), horizon: String(DEFAULT_HORIZON_H) };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (k) out[k] = argv[i + 1];
  }
  if (!out.journal || !out.out) {
    console.error('usage: node scripts/backfill_sl_counterfactual.js --journal <in.csv> --out <out.csv>'
      + ' [--overrides <r-distance-overrides.json>] [--venue okx|bybit]'
      + ' [--buffers 0.3,0.5,1.0] [--horizon 48]');
    process.exit(2);
  }
  if (!VENUES[out.venue]) { console.error(`unknown venue: ${out.venue}`); process.exit(2); }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const venue = VENUES[args.venue];
  const overrides = loadOverrides(args.overrides);
  const buffers = args.buffers.split(',').map(Number).filter((n) => n > 0);
  const horizonMs = Number(args.horizon) * 36e5;
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

  const losses = trades.filter((t) => t.result === 'Loss');
  console.error(`${losses.length} stop-outs · buffers ${buffers.map((b) => b + '%').join(' / ')}`
    + ` · +${args.horizon}h past exit · venue ${venue.label}\n`);

  const rows = [];
  let prevEntryMs = null;

  for (const t of trades) {
    // Every trade advances the anchor, but only the losses are tested.
    const anchor = prevEntryMs;
    if (t.entryTs) prevEntryMs = t.entryTs.ms;
    if (t.result !== 'Loss') continue;

    const label = `#${String(t.id).padStart(2)} ${t.base.padEnd(6)}`;
    try {
      const sym = resolvePair(t.base);
      if (!sym || !(await venue.exists(sym))) throw new Error(`not listed on ${venue.label}`);

      const override = overrides[t.id];
      const rDistance = override
        ? (override.initialRiskUsd * t.entryPrice) / t.notional
        : Math.abs(t.entryPrice - t.initialSl);

      const win = await resolveWindow(venue, sym, t, anchor, now);
      const horizonEnd = Math.min(win.exit + horizonMs, now);
      const bars = await fetchRange(venue, sym, win.fill, horizonEnd);
      if (!bars.length) throw new Error('venue returned no bars');

      const isLong = t.direction === 'long';
      const sign = isLong ? 1 : -1;

      // Widen from the EFFECTIVE initial stop, not the logged one. On a row whose
      // stop column was overwritten by trailing, the logged value is the trailed
      // level, so widening it would widen the wrong level by the wrong amount.
      // Where no override applies this is identical to the logged stop.
      const effectiveSl = t.entryPrice - sign * rDistance;

      // The level the trade was actually aiming at, on the ORIGINAL risk.
      const originalTp1 = t.entryPrice + sign * 2 * rDistance;
      const originalTp1Hit = touched(bars, { isLong, price: originalTp1 });

      // A trailed trade that exited above its initial stop was never killed by
      // that stop, so "would a wider stop have saved it" has no meaning for it.
      // Counting those among the stop-outs would silently pad the survivor
      // column with trades that never died there.
      // Tolerance, because 15m OHLC does not always contain the exact wick that
      // triggered the stop on the exchange. One logged stop-out came back a
      // fraction under 1R of adverse excursion and an exact test wrongly threw
      // it out. 2% of R absorbs that rounding while still sitting far clear of a
      // real trailed exit, which lands roughly half an R short of its stop.
      const STOP_TOUCH_TOLERANCE = 0.02;
      const reach = effectiveSl + sign * rDistance * STOP_TOUCH_TOLERANCE;
      const preExit = bars.filter((b) => b.t < win.exit);
      const diedAtInitialStop = preExit.some((b) => (isLong ? b.l <= reach : b.h >= reach));
      if (!diedAtInitialStop) {
        console.error(`${label} EXCLUDED — exited before its initial stop (trailed); not a stop-out`);
        rows.push({
          trade_id: t.id, pair: t.base, direction: t.direction,
          fill_ts: iso(win.fill), actual_exit_ts: iso(win.exit),
          r_distance: round(rDistance, 6),
          note: 'excluded: trailed exit, initial stop never touched',
        });
        continue;
      }

      const line = [];
      for (const b of buffers) {
        const widenedSl = effectiveSl - sign * (effectiveSl * (b / 100));
        const newR = Math.abs(t.entryPrice - widenedSl);
        const tp1 = t.entryPrice + sign * 2 * newR;
        const { outcome, at } = race(bars, { isLong, stop: widenedSl, target: tp1 });
        rows.push({
          trade_id: t.id,
          pair: t.base,
          direction: t.direction,
          buffer_pct: b,
          fill_ts: iso(win.fill),
          actual_exit_ts: iso(win.exit),
          horizon_ts: iso(horizonEnd),
          r_distance: round(rDistance, 6),
          widened_sl: round(widenedSl, 6),
          new_r_distance: round(newR, 6),
          tp1_price: round(tp1, 6),
          outcome,
          hours_to_outcome: at === null ? '' : round((at + INTERVAL_15M - win.fill) / 36e5, 2),
          original_2R_price: round(originalTp1, 6),
          original_2R_hit: originalTp1Hit,
          note: override ? `r_distance override: ${override.why}` : '',
        });
        line.push(`${b}%:${outcome === 'stopped' ? 'SL' : outcome === 'tp1' ? 'TP1' : 'open'}`);
      }
      console.error(`${label} ${line.join('  ')}   ${bars.length} bars`
        + `${originalTp1Hit ? '   [original 2R reached]' : ''}`);
    } catch (err) {
      console.error(`${label} FAILED — ${err.message}`);
      rows.push({ trade_id: t.id, pair: t.base, direction: t.direction, note: `failed: ${err.message}` });
    }
  }

  const header = ['trade_id', 'pair', 'direction', 'buffer_pct', 'fill_ts', 'actual_exit_ts',
    'horizon_ts', 'r_distance', 'widened_sl', 'new_r_distance', 'tp1_price', 'outcome',
    'hours_to_outcome', 'original_2R_price', 'original_2R_hit', 'note'];
  writeFileSync(args.out,
    [header.join(','), ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n');

  summarise(rows, buffers, args.out, args.horizon);
}

const round = (n, d) => Number(n.toFixed(d));
const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function summarise(rows, buffers, outPath, horizon) {
  console.error(`\nwrote ${outPath}`);
  console.error(`\n§IV Step 6 counterfactual — stop widened by b%, window +${horizon}h past the actual exit`);
  console.error('a loss still costs exactly 1R (sizing shrinks with the stop), so the cost of b');
  console.error('is a further TP1, not a bigger loss\n');
  console.error('   buffer   survived   of those reached TP1   still stopped   undecided at horizon');
  for (const b of buffers) {
    const r = rows.filter((x) => x.buffer_pct === b && x.outcome);
    const stopped = r.filter((x) => x.outcome === 'stopped').length;
    const tp1 = r.filter((x) => x.outcome === 'tp1').length;
    const open = r.filter((x) => x.outcome === 'open_at_horizon').length;
    const survived = tp1 + open;
    console.error(`   ${String(b).padStart(4)}%   ${String(survived).padStart(8)}`
      + `   ${String(tp1).padStart(19)}   ${String(stopped).padStart(13)}   ${String(open).padStart(19)}`);
  }
  const tested = new Set(rows.filter((r) => r.outcome).map((r) => r.trade_id)).size;
  const excluded = rows.filter((r) => String(r.note).startsWith('excluded:'));
  if (excluded.length) {
    console.error(`\n${excluded.length} logged loss(es) excluded — trailed out above the initial stop,`
      + ' so a wider initial stop could not have changed them:');
    for (const e of excluded) console.error(`  #${e.trade_id} ${e.pair}`);
  }
  const orig = rows.filter((r) => r.buffer_pct === buffers[0] && r.original_2R_hit === true);
  console.error(`\n${tested} stop-outs tested.`);
  console.error(`${orig.length} of them reached the ORIGINAL 2R target within the extended window`
    + ' — the ceiling on what any buffer can recover.');
  const failed = rows.filter((r) => !r.outcome);
  for (const f of failed) console.error(`  #${f.trade_id} ${f.pair} — ${f.note}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { race, touched };
