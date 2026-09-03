import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAsset, THRESHOLDS } from '../src/score.js';

const base = {
  etfFlow: 0, etfProxy: false, funding: 0.005,
  chg1h: 0, oiD1h: 0, emaSide: 0,
  sweep: { layer: 0, label: 'inside PDH/PDL range' },
};
const layer = (r, key) => r.layers.find((l) => l.key === key).value;

test('all-neutral input scores 0 and reads CHOPPY', () => {
  const r = scoreAsset(base);
  assert.equal(r.total, 0);
  assert.equal(r.cls, 'chop');
  assert.match(r.verdict, /CHOPPY/);
});

test('a maximal bullish stack scores +5 and reads CLEAR TO LONG', () => {
  const r = scoreAsset({
    ...base, etfFlow: 100e6, funding: -0.01, chg1h: 1, oiD1h: 1,
    emaSide: 1, sweep: { layer: 1, label: 'PDL swept + reclaimed' },
  });
  assert.equal(r.total, 5);
  assert.equal(r.cls, 'long');
  assert.match(r.verdict, /CLEAR TO LONG/);
});

test('a maximal bearish stack scores -5 and reads CLEAR TO SHORT', () => {
  const r = scoreAsset({
    ...base, etfFlow: -100e6, funding: 0.05, chg1h: -1, oiD1h: -1,
    emaSide: -1, sweep: { layer: -1, label: 'PDH swept + rejected' },
  });
  assert.equal(r.total, -5);
  assert.equal(r.cls, 'short');
});

test('funding boundaries are exclusive and resolve to neutral', () => {
  assert.equal(layer(scoreAsset({ ...base, funding: 0 }), 'funding'), 0);
  assert.equal(layer(scoreAsset({ ...base, funding: THRESHOLDS.fundingBearPct }), 'funding'), 0);
  assert.equal(layer(scoreAsset({ ...base, funding: 0.012 }), 'funding'), 0); // the undefined band
  assert.equal(layer(scoreAsset({ ...base, funding: -0.0001 }), 'funding'), 1);
  assert.equal(layer(scoreAsset({ ...base, funding: 0.0151 }), 'funding'), -1);
});

test('OI layer stays literal to section VII: only two quadrants score', () => {
  const q = (chg1h, oiD1h) => scoreAsset({ ...base, chg1h, oiD1h });
  assert.equal(layer(q(1, 1), 'oi'), 1);    // long buildup
  assert.equal(layer(q(-1, -1), 'oi'), -1); // long flush
  assert.equal(layer(q(-1, 1), 'oi'), 0);   // fresh shorts -> unscored
  assert.equal(layer(q(1, -1), 'oi'), 0);   // short covering -> unscored
});

test('unscored OI quadrants are still labelled for the UI badge', () => {
  const detail = (chg1h, oiD1h) =>
    scoreAsset({ ...base, chg1h, oiD1h }).layers.find((l) => l.key === 'oi').detail;
  assert.equal(detail(-1, 1), 'fresh shorts');
  assert.equal(detail(1, -1), 'short covering');
});

test('a missing ETF flow scores 0 rather than throwing', () => {
  const r = scoreAsset({ ...base, etfFlow: null });
  assert.equal(layer(r, 'etf'), 0);
  assert.equal(r.layers.find((l) => l.key === 'etf').detail, 'no data');
});

test('a proxied ETF flow scores 0 regardless of magnitude, but still carries the proxy flag and the raw number', () => {
  const bull = scoreAsset({ ...base, etfFlow: 100e6, etfProxy: true });
  assert.equal(layer(bull, 'etf'), 0);
  assert.equal(bull.layers.find((l) => l.key === 'etf').proxy, true);
  assert.match(bull.layers.find((l) => l.key === 'etf').detail, /\+\$100M/);

  const bear = scoreAsset({ ...base, etfFlow: -100e6, etfProxy: true });
  assert.equal(layer(bear, 'etf'), 0);
});

test('regression: a proxied ETF outflow must not, by itself, tip a non-BTC asset into CLEAR TO SHORT', () => {
  // Same shape as the dashboard misreading a discount-POI long as a short:
  // OI (long flush) and EMA (below) genuinely score -1 each; funding and
  // sweep sit neutral. Before the fix, BTC's proxied outflow added a third
  // -1 and crossed the -3 threshold on its own. It must now stay neutral.
  const input = {
    ...base, etfFlow: -100e6, etfProxy: true, funding: 0.005, chg1h: -1, oiD1h: -1, emaSide: -1,
  };
  const r = scoreAsset(input);
  assert.equal(layer(r, 'etf'), 0);
  assert.equal(r.total, -2);
  assert.equal(r.cls, 'chop');
  assert.match(r.verdict, /CHOPPY/);

  const asIfAssetSpecific = scoreAsset({ ...input, etfProxy: false });
  assert.equal(asIfAssetSpecific.total, -3);
  assert.equal(asIfAssetSpecific.cls, 'short');
});

test('always returns exactly five layers', () => {
  assert.equal(scoreAsset(base).layers.length, 5);
});
