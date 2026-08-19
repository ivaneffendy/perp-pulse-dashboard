import test from 'node:test';
import assert from 'node:assert/strict';
import { UPSTREAM_HEADERS } from '../src/index.js';

test('REGRESSION: upstream requests carry a descriptive User-Agent', () => {
  // Workers send no UA by default and CoinGecko answers 403:
  // "Please add a descriptive User-Agent to your request."
  // That 403 is swallowed by fetchMacro's catch, so the only visible symptom
  // was an empty weather widget in production. Guard it here instead.
  const ua = UPSTREAM_HEADERS['User-Agent'];
  assert.ok(ua && ua.length > 10, 'User-Agent must be present and descriptive');
  assert.match(ua, /perp-pulse/i);
});
