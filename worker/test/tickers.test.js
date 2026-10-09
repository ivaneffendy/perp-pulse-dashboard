import test from 'node:test';
import assert from 'node:assert/strict';
import { bybitTickers } from '../src/sources/bybit.js';
import { okxTickers } from '../src/sources/okx.js';

test('bybitTickers passes the last price through as a number', async () => {
  const { tickers } = await bybitTickers(async () => ({
    result: { list: [{ symbol: 'SOLUSDT', price24hPcnt: '0.02', turnover24h: '500000000', lastPrice: '112.4' }] },
  }));
  assert.equal(tickers[0].last, 112.4);
});

test('okxTickers passes the last price through as a number', async () => {
  const { tickers } = await okxTickers(async () => ({
    data: [{ instId: 'SOL-USDT-SWAP', open24h: '110', last: '112.4', volCcy24h: '5000000' }],
  }));
  assert.equal(tickers[0].last, 112.4);
});
