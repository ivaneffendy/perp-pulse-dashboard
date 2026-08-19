/**
 * Playbook §VII — the -5..+5 pre-market bias score.
 *
 * This is Phase 1 ("what is the bias?"). It is NOT verdict.js, which answers
 * Phase 2 ("is this pullback safe to enter?"). The two give opposite signs on
 * price-down + OI-down and must never be summed or averaged.
 */

export const THRESHOLDS = {
  // Measurement window for layer 3 is 1 hour. Neither §VII nor the PRD states
  // one; these are the values already tuned in the original Worker.
  priceMovePct: 0.15,
  oiMovePct: 0.25,
  fundingBullPct: 0,
  fundingBearPct: 0.015,
  etfFlowUsd: 50e6,
};

const fmtM = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v / 1e6).toFixed(0)}M`;

export function scoreAsset(input) {
  const T = THRESHOLDS;
  const layers = [];

  // Layer 1 — Spot ETF net flows (macro; proxied onto alts)
  let etf = 0;
  if (input.etfFlow != null) {
    if (input.etfFlow > T.etfFlowUsd) etf = 1;
    else if (input.etfFlow < -T.etfFlowUsd) etf = -1;
  }
  layers.push({
    key: 'etf', label: 'ETF', value: etf,
    detail: input.etfFlow == null ? 'no data' : fmtM(input.etfFlow),
    proxy: !!input.etfProxy,
  });

  // Layer 2 — Funding. §VII leaves 0–0.005% and 0.01–0.015% undefined; both
  // fall to neutral here, which is the conservative read. Bounds are exclusive.
  let funding = 0;
  if (input.funding < T.fundingBullPct) funding = 1;
  else if (input.funding > T.fundingBearPct) funding = -1;
  layers.push({
    key: 'funding', label: 'Fund', value: funding,
    detail: `${input.funding.toFixed(4)}%`,
  });

  // Layer 3 — OI + price delta. Kept LITERAL to §VII: only the two named
  // quadrants score. The other two are labelled for a UI badge but stay 0,
  // rather than inventing signs the playbook never assigned.
  const pUp = input.chg1h > T.priceMovePct;
  const pDown = input.chg1h < -T.priceMovePct;
  const oUp = input.oiD1h > T.oiMovePct;
  const oDown = input.oiD1h < -T.oiMovePct;

  let oi = 0, oiDetail = 'flat / stagnant OI';
  if (pUp && oUp) { oi = 1; oiDetail = 'long buildup'; }
  else if (pDown && oDown) { oi = -1; oiDetail = 'long flush'; }
  else if (pDown && oUp) { oiDetail = 'fresh shorts'; }
  else if (pUp && oDown) { oiDetail = 'short covering'; }
  layers.push({ key: 'oi', label: 'OI', value: oi, detail: oiDetail });

  // Layer 4 — EMA34 alignment
  layers.push({
    key: 'ema', label: 'EMA', value: input.emaSide,
    detail: input.emaSide === 0 ? 'oscillating inside EMA'
      : input.emaSide > 0 ? 'body close above EMA34' : 'body close below EMA34',
  });

  // Layer 5 — Liquidity sweep
  layers.push({
    key: 'sweep', label: 'Sweep', value: input.sweep.layer, detail: input.sweep.label,
  });

  const total = layers.reduce((s, l) => s + l.value, 0);
  const cls = total >= 3 ? 'long' : total <= -3 ? 'short' : 'chop';
  const verdict = cls === 'long' ? 'CLEAR TO LONG'
    : cls === 'short' ? 'CLEAR TO SHORT' : 'CHOPPY / RANGE';

  return { total, verdict, cls, layers };
}
