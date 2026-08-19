import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepState } from '../src/compute/sweep.js';

const day = (l, h) => ({ t: 0, o: l, h, l, c: h, v: 1 });
const prev = day(100, 200); // PDL 100, PDH 200

test('scores +1 when PDL is swept and reclaimed', () => {
  const s = sweepState(prev, day(95, 150), 120);
  assert.equal(s.layer, 1);
  assert.match(s.label, /PDL/);
});

test('scores -1 when PDH is swept and rejected', () => {
  const s = sweepState(prev, day(150, 210), 180);
  assert.equal(s.layer, -1);
  assert.match(s.label, /PDH/);
});

test('scores 0 when PDL is swept but price has not reclaimed', () => {
  assert.equal(sweepState(prev, day(95, 150), 98).layer, 0);
});

test('scores 0 when PDH is swept and price is still above it', () => {
  assert.equal(sweepState(prev, day(150, 210), 205).layer, 0);
});

test('scores 0 and flags when both sides are swept', () => {
  const s = sweepState(prev, day(95, 210), 150);
  assert.equal(s.layer, 0);
  assert.equal(s.label, 'both swept');
});

test('scores 0 inside the previous range', () => {
  const s = sweepState(prev, day(120, 180), 150);
  assert.equal(s.layer, 0);
  assert.match(s.label, /inside/);
});

test('degrades safely with missing data', () => {
  assert.equal(sweepState(null, day(1, 2), 1).layer, 0);
  assert.equal(sweepState(null, day(1, 2), 1).pdh, null);
  const noToday = sweepState(prev, null, 1);
  assert.equal(noToday.layer, 0);
  assert.equal(noToday.label, 'no data');
  assert.equal(noToday.pdh, 200); // still known from the previous day
});
