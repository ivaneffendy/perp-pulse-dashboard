/**
 * The liquidity-rail line the Chart tab prints, and that a chart read records
 * as `dash_liq_raw`. One builder for both: the Chart tab and dash_snapshot.js
 * import the same function, so the recorded line is the one on screen.
 *
 * Every level below is INVENTED. This repo is public.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { liqLine, selectPools, poolName } from '../src/liq-line.js';

const pool = (tier, side, level, offsetPct, { touches = 1, swept = false } = {}) =>
  ({ tier, side, level, offsetPct, distPct: Math.abs(offsetPct), touches, swept });

// Already sorted nearest-first, as findLiquidity returns them.
const POOLS = [
  pool('CLUSTER', 'high', 1210, -0.1, { touches: 3, swept: true }),
  pool('FRACTAL', 'high', 1220, 0.2, { swept: true }),
  pool('FRACTAL', 'low', 1195, -0.3),
  pool('CLUSTER', 'high', 1240, 0.5, { touches: 2 }),
  pool('CLUSTER', 'low', 1190, -0.7, { touches: 2 }),
  pool('PD', 'high', 1234, 0.92, { swept: true }),
  pool('FRACTAL', 'high', 1260, 1.1),
  pool('CLUSTER', 'low', 1180, -1.2, { touches: 4 }),
  pool('CLUSTER', 'high', 1270, 1.5, { touches: 2 }),
  pool('PD', 'low', 1150, -1.62),
  pool('FRACTAL', 'low', 1140, -2.0, { swept: true }),
  pool('FRACTAL', 'low', 1130, -2.4),
  pool('FRACTAL', 'high', 1300, 3.0),
  pool('FRACTAL', 'high', 1310, 3.5),
];

test('poolName names each tier and side', () => {
  assert.equal(poolName(pool('PD', 'high', 1, 0)), 'PDH');
  assert.equal(poolName(pool('PD', 'low', 1, 0)), 'PDL');
  assert.equal(poolName(pool('CLUSTER', 'high', 1, 0)), 'EQH');
  assert.equal(poolName(pool('CLUSTER', 'low', 1, 0)), 'EQL');
  assert.equal(poolName(pool('FRACTAL', 'high', 1, 0)), 'SWH');
  assert.equal(poolName(pool('FRACTAL', 'low', 1, 0)), 'SWL');
});

test('selectPools keeps both PD levels, 4 nearest clusters, 4 nearest unswept fractals', () => {
  const picked = selectPools(POOLS);
  assert.deepEqual(picked.map((p) => `${poolName(p)} ${p.level}`), [
    'PDH 1234', 'PDL 1150',
    'EQH 1210', 'EQH 1240', 'EQL 1190', 'EQL 1180',
    'SWL 1195', 'SWH 1260', 'SWL 1130', 'SWH 1300',
  ]);
});

test('liqLine prints the exact string the Chart tab copies', () => {
  assert.equal(liqLine('FAKE', POOLS),
    'LIQ 4H FAKE | PDH 1,234 swept +0.92% | PDL 1,150 unswept -1.62%'
    + ' | EQH 1,210 x3 swept -0.10% | EQH 1,240 x2 unswept +0.50%'
    + ' | EQL 1,190 x2 unswept -0.70% | EQL 1,180 x4 unswept -1.20%'
    + ' | SWL 1,195 unswept -0.30% | SWH 1,260 unswept +1.10%'
    + ' | SWL 1,130 unswept -2.40% | SWH 1,300 unswept +3.00%');
});

test('liqLine with no pools is the bare header', () => {
  assert.equal(liqLine('FAKE', []), 'LIQ 4H FAKE');
});
