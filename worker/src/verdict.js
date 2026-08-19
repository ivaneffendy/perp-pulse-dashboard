/**
 * Phase 2 — pullback health. Answers "is this pullback absorption or a knife?"
 *
 * NOT the same question as score.js (§VII bias). On price-down + OI-down this
 * says "ok / deleveraging" while §VII scores -1 bearish. Both are correct for
 * their own question; never sum or average them.
 *
 * The planned TradingView -> Telegram worker must import THIS function rather
 * than reimplementing the read.
 */
export function verdict(d) {
  const pDown = d.chg1h < -0.15, pUp = d.chg1h > 0.15;
  const oiDown = d.oiD1h < -0.25, oiUp = d.oiD1h > 0.25;
  let cls = 'mixed', msg;

  if (pDown && oiDown) {
    cls = 'ok';
    msg = `Price down ${d.chg1h.toFixed(2)}% with OI dropping ${d.oiD1h.toFixed(2)}% — longs closing or getting flushed, not fresh selling. Deleveraging pullback; POI mitigation has better odds of holding.`;
  } else if (pDown && oiUp) {
    cls = 'risk';
    msg = `Price down ${d.chg1h.toFixed(2)}% while OI is building +${d.oiD1h.toFixed(2)}% — new shorts opening into the move. Aggressive selling, not a healthy pullback. Want stronger confirmation.`;
  } else if (pUp && oiUp) {
    cls = 'ok';
    msg = `Price up +${d.chg1h.toFixed(2)}% with OI expanding +${d.oiD1h.toFixed(2)}% — fresh longs backing the move with new money.`;
  } else if (pUp && oiDown) {
    cls = 'mixed';
    msg = `Price up +${d.chg1h.toFixed(2)}% but OI shrinking ${d.oiD1h.toFixed(2)}% — likely short covering, weaker fuel for continuation.`;
  } else {
    msg = `Flat hour (${d.chg1h.toFixed(2)}% price, ${d.oiD1h.toFixed(2)}% OI). No strong positioning signal — lean on your HTF structure.`;
  }

  if (d.funding <= -0.01) msg += ` Funding negative (${d.funding.toFixed(4)}%): shorts paying, crowded downside — squeeze fuel.`;
  else if (d.funding >= 0.02) msg += ` Funding elevated (${d.funding.toFixed(4)}%): longs crowded, watch for a flush.`;

  if (d.taker != null) {
    if (d.taker < 0.9) msg += ` Taker flow ${d.taker.toFixed(2)} — sellers hitting market.`;
    else if (d.taker > 1.1) msg += ` Taker flow ${d.taker.toFixed(2)} — buyers lifting offers.`;
  }

  const bk = d.book;
  if (bk) {
    const aw = bk.ask.nearestWall, bw = bk.bid.nearestWall;
    const skew = bk.imbalancePct >= 55 ? 'bids stacked' : bk.imbalancePct <= 45 ? 'asks stacked' : 'balanced';
    if (aw || bw) {
      const parts = [];
      if (aw) parts.push(`ask +${aw.distPct.toFixed(2)}%`);
      if (bw) parts.push(`bid ${bw.distPct.toFixed(2)}%`);
      msg += ` Book: nearest ${parts.join(' / ')}, resting ${skew} (${bk.imbalancePct.toFixed(0)}% bid).`;
    } else {
      msg += ` Book: no distinct wall within ±${bk.band.toFixed(1)}% (smooth), resting ${skew} (${bk.imbalancePct.toFixed(0)}% bid).`;
    }
  }
  return { cls, msg };
}
