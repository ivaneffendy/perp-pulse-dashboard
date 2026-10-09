# Candidates — 4H trend + pullback pre-screen design

Date: 2026-10-09
Status: approved in session (§1–§3), awaiting written-spec review

## The question this answers

The Movers tab answers *what moved unusually today?* It ranks by the size of
the 24h move against BTC (`worker/src/compute/movers.js`), so by construction
its top rows are the coins **furthest from any pullback**. A POI marked on one
of them sits far from price and rarely fills inside the operator's horizon.
That is not a tuning problem: "biggest move" and "near a POI" pull in opposite
directions.

Candidates answers a different question for the morning mapping pass: *which
liquid coins are trending on the 4H and have pulled back into the value half of
their current leg right now?* The goal is that the pass ends with 2–3
chartable with-trend candidates instead of an open-ended hunt.

## What it is not

- **Not a verdict.** It is a pre-screen. The operator's chart read still
  decides. The list and the chart read will sometimes disagree (see
  *Validation*), and the list is never a reason to skip the read.
- **Not scored.** `anchored.js` is never imported by `score.js`, `verdict.js`,
  `absorption.js` or `regime.js`, enforced by source inspection, the same guard
  `movers.js` carries.
- **Not a replacement for Movers.** Movers stays as the awareness list, below
  this section.
- **Not a replacement for the rolling 30-bar range** in `equilibrium.js` /
  `dash_snapshot`. That swap is a natural follow-up and out of scope here.

## The definitions it implements

Taken from the trading playbook (private sibling vault), stated here so this
repo stands alone:

- **Trend (HTF structure).** Long side when the last 4H break of structure was
  up (`HH+HL`), short side when it was down (`LL+LH`).
- **Anchored range.** From the **protected point** to the **latest extreme**
  of the current 4H leg. Uptrend: from the HL that produced the last body-close
  BOS up to the latest HH. Downtrend mirrors it. The range re-anchors **only**
  on a new body-close 4H BOS. It never follows price down a leg. Re-anchoring
  on every leg would manufacture a fresh discount at each lower level, which is
  the defect of a rolling window.
- **Value half.** A long is *in zone* below 50% of the anchored range while
  still above the protected low. A short is *in zone* above 50% while still
  below the protected high.

## §1 — `worker/src/compute/anchored.js`

Pure function over closed 4H bars plus a live price.

**Input:** up to 200 closed 4H bars (one venue call, about 33 days) and the
ticker's last price. The forming bar is already dropped by `normalizeKlines`.

1. **Swings.** Fractal highs and lows at **width 3**: a bar's high exceeds the
   highs of the 3 bars on each side (lows mirrored). A swing becomes known only
   once 3 bars after it have closed. Width 3 was chosen against a real case:
   on BTC 4H ending 2026-10-07 02:42Z, width 2 (the `mode.js` fractal) took a
   minor dip as the protected low (30 swing highs in 33 days, internal
   structure). Widths 3, 4 and 5 all gave 83,107.7 → 87,242.2, against a
   hand-drawn 83,200 → 87,200. Width 3 is the smallest width that agrees. One
   datapoint, a sanity check and not a calibration.
2. **BOS.** Two kinds, and only two:
   - **With-trend:** a bar whose **body closes** beyond the most recent known,
     not-yet-broken swing in the trend's direction. That close marks **every**
     known swing it closed beyond as broken, not just the most recent one.
     Without this, the next bars "break" older swings price had already
     cleared, and the protected point slides back to older lows. A first
     prototype did exactly that and put BTC's protected low at 82,722, not
     83,107.7.
   - **Counter-trend (the flip):** a body close through the **protected
     point**. A close below an internal swing low that sits above the
     protected low is *not* a break. The discount half lies above the
     protected low by construction, and that is the pullback being screened
     for.
   - **Bootstrap:** before any BOS exists, the first close beyond a known
     unbroken swing on either side sets the side.
3. **Protected point.** For an up-BOS that broke swing high *H*: the lowest
   **wick** low from *H* to the BOS bar inclusive, i.e. the origin of the
   breaking leg. Mirrored for a down-BOS. Wicks, not bodies: the stop sits under
   the wick.
4. **Latest extreme.** The highest high from the BOS bar onward, then
   `max(extreme, last)` so a new high printed in the forming bar reads as about
   100% rather than a stale range. Mirrored for shorts.
5. **Re-anchoring.** Only a new body-close BOS moves the anchor. On a flip,
   the broken level is the old protected point, and the new protected point
   is the extreme of the leg that broke it: the highest high from the old
   protected low to the flip bar for a new downtrend, mirrored for a new
   uptrend. A wick through without a close does not flip.
6. **Output per coin:**

   ```js
   { side: 'long'|'short'|null, protected, extreme, pctOfRange,
     distToProtectedPct, bosAgeBars,
     status: 'in_zone'|'outside'|'broken'|'unclear' }
   ```

   - `broken`: the live price is already through the protected point with no
     closed bar confirming it yet. A POI there is a reversal POI, not a
     with-trend one, so it is never a candidate.
   - `unclear`: fewer than 20 closed bars, or no BOS in the window.

There is **no "approaching" threshold.** Any cut there would be invented. The
full sorted list of 10–20 coins is a ten-second read.

## §2 — `GET /candidates`

```
client (top-100 list already fetched for Movers)
  └─ GET /candidates?top100=BTC,ETH,…&exclude=BTW
       Worker:
       1. tickers, one call (Bybit, OKX fallback)          → 1–2 subrequests
       2. universe = turnover24h ≥ $100M ∩ top100 − exclude,
          capped at 20 by turnover
       3. 200 × 4H klines per coin, ON THE VENUE THAT        → ≤ 20 subrequests
          SERVED THE TICKERS (no per-coin fallback)
       4. anchored() per coin
```

At most about 22 subrequests against the free plan's 50. All coins on one venue
keeps the turnover criterion and the structure on the same book, avoiding the
cross-venue mixing that `backfill_mfe` had to stamp after the fact.

**The top-100 allowlist is load-bearing here.** A turnover floor alone admits
non-crypto Bybit linear listings. Measured 2026-10-09: of 18 symbols at
≥ $100M, three were `SOXL`, `CL` and `XAU`, and `SNDK` appears at ≥ $50M. The
cap-rank allowlist Movers already fetches client-side (`src/marketcap.js`)
removes them.

**Ticker change:** `bybitTickers` and `okxTickers` also pass `last` through.
This is additive, and Movers ignores it.

**Response:**

```js
{ ts, source, criterion: { turnoverFloor: 100e6, swingWidth: 3 },
  universeFiltered: true, excluded: ['BTW'],
  items: [{ base, turnover24h, last, side, protected, extreme, pctOfRange,
            distToProtectedPct, bosAgeBars, status, detail? }] }
```

`status` gains `'error'` at this layer for a coin whose klines failed.

**Sort:** `in_zone`, then `outside`, each by distance from 50% (closest
first). Then `broken`, `unclear` and `error`, **listed, never dropped**, so a
coin missing from the list always means "below the criterion" and never
"something failed quietly".

**Failures:**

| case | behaviour |
|---|---|
| Tickers fail on both venues | 502 `{ error: 'No venue could serve market tickers' }`, the same shape as `/movers` |
| One coin's klines fail | That item `status: 'error'` with `detail`; the rest still return |
| `top100` absent or empty | Screen anyway, `universeFiltered: false`; the UI shows a banner. Fail loud, not empty |
| `exclude` absent | No exclusion. The client always sends it |

**Config** lives beside the module, like `MOVERS`:

```js
export const CANDIDATES = { floor: 100_000_000, cap: 20, swingWidth: 3, bars: 200 };
```

## §3 — UI, tests

**UI.** A **Candidates** section at the top of the Movers tab, above the
awareness list, because it is the part acted on during the mapping pass:

```
CANDIDATES — 4H trend + pullback (pre-screen; the chart read decides)
SOL   LONG   in zone  31%   prot 112.4 (−4.1%)   BOS 3d   $584M
NEAR  LONG   in zone  44%   prot 4.73 (−6.0%)    BOS 1d   $195M
ENA   SHORT  outside  58%   prot 0.512 (+9.2%)   BOS 5d   $140M  off-list
ADA   —      broken                                        $101M  off-list
⚠ unfiltered — may include non-crypto (XAU, CL)
```

*(Figures illustrative.)*

- **`off-list` chip** on any coin outside the trading watchlist. The client
  holds `WATCHLIST` and `NO_TRADE` in one small module with a comment pointing
  at the playbook's §II as the source of truth. Pair names only.
- Rows are not clickable, matching Movers.
- The fetch rides the same load as `/movers`, after the top-100 list resolves.
  A slow `/candidates` must never delay Phase 1.

**Tests (`worker/test/`, run with `npm test` from `worker/`):**

| file | covers |
|---|---|
| `anchored.test.js` | Synthetic bars for: an up-BOS with the protected low at the leg-origin wick; the latest extreme and the live-price extension; re-anchoring on a new same-side BOS; a body close through the protected point flipping the side; a wick through it without a close not flipping (`broken` when the live price is through); the forming bar ignored; width 3 needing 3 confirming bars each side; no BOS giving `unclear`; the short-side mirror |
| `anchored.test.js`, real-data regression | A committed fixture of BTCUSDT 4H market klines ending 2026-10-07 02:42Z must give side `long`, protected **83,107.7**, extreme **87,242.2**, `pctOfRange` **24.6** (one decimal), `in_zone`. Market data only |
| `candidates.test.js` | With stubbed fetch: the turnover floor, the top-100 filter, `exclude`, the 20-coin cap, every kline request on the tickers' venue, a failed coin returned as `error`, `universeFiltered: false` without `top100`, the sort order, and a subrequest count ≤ 22 |
| guard | Source inspection: no scoring module imports `anchored.js` |
| tickers | `last` is present on both venues' normalised tickers |

## Validation after ship

Fixture tests prove the mechanics, not agreement with a human-drawn range. For
the next ~10 chart reads made under the anchored-range rule, compare the
operator's drawn range high/low with this module's protected/extreme at the
read's timestamp. A persistent disagreement means this code is wrong, not the
marking. The comparison is recorded in the private vault, not here.

The known disagreement shape is already visible on the regression case: the
list would have shown BTC as an in-zone long at 24.6%, while the chart read
refused it on HTF structure, citing 1H lower highs. 4H structure at width 3
had not broken. That is correct behaviour for a 4H pre-screen, and the UI copy
says so.

## Open items, owned elsewhere

- **Watchlist criterion.** Whether a coin this list surfaces is tradeable
  on-list is a playbook decision, tracked in the private vault as R32. Until it
  is adopted, the `off-list` chip reflects the current named list.
