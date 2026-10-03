import { fmtPrice, fmtPct } from './format.js';

/**
 * What actually reaches the rail. liquidity.js returns everything sorted
 * nearest-first and refuses to make this choice for us, so the phone-screen
 * budget is spent here:
 *   - both PD levels always — only two lines, and §III.1 Pillar 5 names them
 *   - the 4 nearest clusters, swept ones included: a raid that already
 *     happened is information, it just gets drawn hollow
 *   - the 4 nearest lone fractals, UNSWEPT ONLY — a taken single level is the
 *     weakest thing on the chart and purely noise
 *
 * Its own module so the Chart tab and scripts/dash_snapshot.js share one
 * definition: the line a chart read records must be the line on screen.
 */
const MAX_CLUSTERS = 4, MAX_FRACTALS = 4;
export function selectPools(pools) {
  const take = (tier, n, keep = () => true) =>
    pools.filter((x) => x.tier === tier && keep(x)).slice(0, n);
  return [
    ...take('PD', 2),
    ...take('CLUSTER', MAX_CLUSTERS),
    ...take('FRACTAL', MAX_FRACTALS, (x) => !x.swept),
  ];
}

/** PDH/PDL · EQH/EQL (equal = clustered) · SWH/SWL (a lone swing). */
export function poolName(p) {
  if (p.tier === 'PD') return p.side === 'high' ? 'PDH' : 'PDL';
  if (p.tier === 'CLUSTER') return p.side === 'high' ? 'EQH' : 'EQL';
  return p.side === 'high' ? 'SWH' : 'SWL';
}

/**
 * The line the operator used to paste into a chart read, now recorded
 * directly as `dash_liq_raw`. Built from the SELECTED pools, not all of them,
 * on purpose: what gets recorded must be exactly what was on screen when it
 * was read, or the two stop being comparable. `pools` is findLiquidity's
 * full, unselected list.
 */
export function liqLine(base, pools) {
  return [`LIQ 4H ${base}`, ...selectPools(pools).map((x) =>
    `${poolName(x)} ${fmtPrice(x.level)}${x.touches > 1 ? ` x${x.touches}` : ''}`
    + ` ${x.swept ? 'swept' : 'unswept'} ${fmtPct(x.offsetPct)}`,
  )].join(' | ');
}
