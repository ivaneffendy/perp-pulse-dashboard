# Extended tab — 4H RSI extremes, read beside the trend

Date: 2026-11-18 · Status: built

## Why

The owner wanted a list of coins already oversold/overbought, so the RSI
doesn't have to be checked in TradingView coin by coin. The playbook trades
trend continuation, so §III.0 refuses most reversal entries anyway. The list
is for awareness, not entries.

The risk is the point of the design. RSI measures momentum, not exhaustion:
in a trend it sits above 70 or below 30 for days. The owner's private journal
records fading "the pump is exhausted" as a repeated losing pattern. A bare
"overbought" list is a list of fade prompts. So **every row shows the 4H
trend context**, and the labels describe what to *not* do.

## What

| RSI zone vs 4H side (`anchoredRange`) | Label |
|---|---|
| OB in an uptrend, OS in a downtrend | `with trend · late, don't chase` |
| OB in a downtrend, OS in an uptrend | `against trend · needs 4H BOS` |
| price through the protected point | `4H structure broken` |
| no 4H structure | `trend unclear` |

- RSI(14), Wilder, on **closed** 4H bars. Zones: OS ≤ 30, extreme ≤ 20,
  OB ≥ 70, extreme ≥ 80 (`worker/src/compute/rsi.js`, `RSI`).
- Universe = the Candidates universe (≤ 20 coins, top 100 by market cap,
  ≥ $100M turnover, no-trade list excluded). A watchlist coin outside that
  cut does not appear.
- **No fetch of its own.** `/candidates` already pulls 200 closed 4H bars per
  coin; each item gains `rsi4h`. One response renders both tabs, so the
  fetch policy (`shouldFetchCandidates`) treats opening either tab as looking.
- Sorted by distance from 50, most extreme first. No up/down colours: an RSI
  extreme is not a direction.
- Display-only. `rsi.js` is never imported by `score.js`, `verdict.js`,
  `absorption.js` or `regime.js` (`test/rsi.test.js`, source inspection).

## Tracking

`scripts/dash_snapshot.js` adds `rsi4h` to the chart-read snapshot, from a
**separate** 200-bar `/candles` call, so the number matches the tab's (Wilder
smoothing depends on history length) and the liquidity line keeps its own
90-bar call. The private vault records it as `chart-reads.csv`
`dash_rsi_4h`. The adjudicator never sees it.

## Fixed on the way

`shouldFetchCandidates` returned true for `trigger: 'open'` on **any** tab,
so switching to Matrix or Chart before ever opening Candidates fired the
~21-call fetch. It now gates on the tab being Candidates or Extended.

## Not done

- 1D RSI: ~20 more kline calls per fetch (≈ 41 of the 50-subrequest cap).
- Divergence detection: a mentor note already rules divergence out as an
  entry trigger; nothing here would change that.
