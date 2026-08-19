/**
 * Playbook §VII layer 5 — liquidity sweep on the previous day's extremes.
 *
 * `today` must be the STILL-FORMING daily candle (build it with
 * normalizeKlines(..., dropUnclosed = false)), because the sweep we care about
 * is happening right now. Day boundary is UTC, matching exchange convention —
 * note this is 7h off from WIB.
 */
export function sweepState(prevDay, today, price) {
  if (!prevDay || !today) {
    return {
      layer: 0,
      label: 'no data',
      pdh: prevDay?.h ?? null,
      pdl: prevDay?.l ?? null,
    };
  }
  const pdh = prevDay.h, pdl = prevDay.l;

  const reclaimedLow = today.l < pdl && price > pdl;
  const rejectedHigh = today.h > pdh && price < pdh;

  if (reclaimedLow && rejectedHigh) return { layer: 0, label: 'both swept', pdh, pdl };
  if (reclaimedLow) return { layer: 1, label: 'PDL swept + reclaimed', pdh, pdl };
  if (rejectedHigh) return { layer: -1, label: 'PDH swept + rejected', pdh, pdl };
  return { layer: 0, label: 'inside PDH/PDL range', pdh, pdl };
}
