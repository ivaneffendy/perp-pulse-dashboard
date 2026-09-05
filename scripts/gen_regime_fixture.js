/**
 * Regenerates worker/test/fixtures/regime-golden.json.
 *
 * Five real BTC 1H windows, each 181 bars ending at the bar being judged, so
 * regime() sees exactly REGIME.lookback (180) baseline bars plus one judged bar.
 *
 * Source is Binance spot BTCUSDT, chosen for depth of history and because this
 * is a fixture, not a live path — the Worker itself never calls Binance spot.
 * These are public market prices. Nothing here touches the journal.
 *
 *   node scripts/gen_regime_fixture.js
 *
 * If a pinned percentile in regime.test.js stops reproducing after a
 * regeneration, that is a real signal: investigate before re-pinning.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'worker', 'test', 'fixtures', 'regime-golden.json');
const H1 = 60 * 60 * 1000;

/**
 * Each entry is the moment a read would have been taken. The judged bar is the
 * newest bar to have CLOSED at that instant.
 */
const CASES = [
  { label: 'cascade following an unscheduled policy announcement, +3h', at: '2025-10-10T22:30:00Z' },
  { label: 'deleveraging cascade', at: '2026-02-06T00:15:00Z' },
  { label: 'top-25 move, still below the display cut at its own window start', at: '2026-03-02T14:15:00Z' },
  { label: 'top-25 move, already above the cut at its window start', at: '2026-08-19T13:45:00Z' },
  { label: 'US session, ~3h after a tier-1 macro release', at: '2026-09-04T15:00:00Z' },
];

async function klines(endMs, limit) {
  const start = endMs - limit * H1;
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h'
    + `&startTime=${start}&endTime=${endMs}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'perp-pulse-fixture/1.0' } });
  if (!res.ok) throw new Error(`Binance ${res.status} for ${url}`);
  return (await res.json()).map((k) => ({
    t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
  }));
}

const out = [];
for (const { label, at } of CASES) {
  const now = Date.parse(at);
  // The judged bar is the newest one whose CLOSE is at or before `now`.
  const judged = Math.floor(now / H1) * H1 - H1;
  const bars = (await klines(judged + H1, 400))
    .filter((b) => b.t <= judged)
    .slice(-181);
  if (bars.length !== 181) throw new Error(`${label}: got ${bars.length} bars, need 181`);
  out.push({ label, judgedBarOpensAt: judged, bars });
  console.log(`${label}: judged bar opens ${new Date(judged).toISOString()}`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`wrote ${OUT}`);
