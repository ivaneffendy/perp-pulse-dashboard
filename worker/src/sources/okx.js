import { computeWalls } from '../compute/walls.js';

const O = 'https://www.okx.com';

/**
 * OKX extras — taker flow, account L/S, OI, and the deepest free REST book.
 * Every call is individually optional: a missing instrument (HYPE and the
 * newer listings are the risk) degrades to Bybit rather than failing the row.
 */
export async function okxExtras(sym, j) {
  const inst = sym.okxInst, ccy = sym.okxCcy;
  const [oi, taker, ls, ob, instr] = await Promise.all([
    j(`${O}/api/v5/public/open-interest?instId=${inst}`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1H`).catch(() => null),
    j(`${O}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`).catch(() => null),
    j(`${O}/api/v5/market/books-full?instId=${inst}&sz=5000`).catch(() => null),
    j(`${O}/api/v5/public/instruments?instType=SWAP&instId=${inst}`).catch(() => null),
  ]);

  // taker-volume rows are [ts, sellVol, buyVol], newest first
  let takerRatio = null;
  const tr = taker?.data?.[0];
  if (tr) { const sell = +tr[1], buy = +tr[2]; takerRatio = sell ? buy / sell : null; }

  let book = null;
  if (ob?.data?.[0]) {
    // OKX book sizes are in CONTRACTS; ctVal converts to base coin.
    const ctVal = +instr?.data?.[0]?.ctVal;
    const scale = Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1;
    const conv = (lv) => lv.map((l) => [l[0], +l[1] * scale]);
    book = computeWalls(conv(ob.data[0].bids), conv(ob.data[0].asks));
    if (book) book.source = 'OKX books-full';
  }

  return {
    oiCoin: oi?.data?.[0] ? +oi.data[0].oiCcy : null,
    taker: takerRatio,
    ls: ls?.data?.[0] ? +ls.data[0][1] : null,
    book,
  };
}
