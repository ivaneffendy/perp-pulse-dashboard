import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankMovers, MOVERS } from '../src/compute/movers.js';

const t = (base, pct24h, turnover24h) => ({ base, pct24h, turnover24h });

test('filters out anything below the turnover floor', () => {
  const tickers = [
    t('BTC', 1, 1_000_000_000),
    t('ARB', 20, 5_000_000),   // below the floor used in this test
    t('SOL', 15, 50_000_000),
  ];
  const out = rankMovers(tickers, { floor: 10_000_000, top: 8 });
  assert.equal(out.some((x) => x.base === 'ARB'), false);
  assert.equal(out.some((x) => x.base === 'SOL'), true);
});

test('excludes BTC from the output but uses its pct24h as the baseline', () => {
  const tickers = [t('BTC', 5, 1_000_000_000), t('ETH', 8, 50_000_000)];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out.some((x) => x.base === 'BTC'), false);
  assert.equal(out.find((x) => x.base === 'ETH').rel, 3); // 8 - 5
});

test('ranks by absolute relative strength, not raw pct24h', () => {
  const tickers = [
    t('BTC', 0, 1_000_000_000),
    t('A', 2, 50_000_000),     // rel = 2
    t('B', -9, 50_000_000),    // rel = -9, bigger magnitude
  ];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out[0].base, 'B');
  assert.equal(out[1].base, 'A');
});

test('slices to the configured top count', () => {
  const tickers = [
    t('BTC', 0, 1e9),
    ...Array.from({ length: 20 }, (_, i) => t(`C${i}`, i, 1e8)),
  ];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out.length, 8);
});

test('empty input returns an empty array, not a throw', () => {
  assert.deepEqual(rankMovers([], { floor: 0, top: 8 }), []);
});

test('all tickers below the floor returns an empty array', () => {
  const tickers = [t('BTC', 0, 1e9), t('ARB', 20, 1)];
  assert.deepEqual(rankMovers(tickers, { floor: 10_000_000, top: 8 }), []);
});

test('a non-array input returns an empty array rather than throwing', () => {
  assert.deepEqual(rankMovers(null, { floor: 0, top: 8 }), []);
  assert.deepEqual(rankMovers(undefined, { floor: 0, top: 8 }), []);
});

test('missing BTC in the input defaults the baseline to 0', () => {
  const tickers = [t('ETH', 4, 50_000_000)];
  const out = rankMovers(tickers, { floor: 0, top: 8 });
  assert.equal(out[0].rel, 4); // 4 - 0
});

test('the exported MOVERS default matches the documented provisional values', () => {
  assert.equal(MOVERS.floor, 10_000_000);
  assert.equal(MOVERS.top, 8);
});

test('movers is never referenced by any of the four scoring engines', () => {
  for (const p of [
    '../src/score.js', '../src/verdict.js',
    '../src/compute/absorption.js', '../src/compute/regime.js',
  ]) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.ok(
      !/movers/i.test(src),
      `${p} references movers — it is awareness-only and must never enter scoring`,
    );
  }
});

test('the frontend movers module never adds interactivity or imports scoring UI', () => {
  const src = readFileSync(new URL('../../src/movers.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener|onclick/i.test(src), 'src/movers.js must stay non-interactive');
  assert.ok(!/score|verdict/i.test(src), 'src/movers.js must never render scoring fields');
  assert.ok(!/from ['"]\.\/(matrix|detail)\.js['"]/.test(src), 'src/movers.js must not import from the scored UI modules');
});
