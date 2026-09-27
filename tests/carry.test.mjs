// DOM-free: carry pairing, flight speed limit, crossfade window and the film cursor path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairCarries, flightDuration, carryFrame, cursorAt, CARRY_DEFAULTS } from '../engine/carry.js';
import { peakSlope } from '../engine/ease.js';

test('pairCarries pairs names only across consecutive units', () => {
  const p = pairCarries([{ id: 'a', names: ['title', 'logo'] }, { id: 'b', names: ['title'] }, { id: 'c', names: ['logo', 'title'] }]);
  assert.deepEqual(p, [{ name: 'title', from: 0, to: 1 }, { name: 'title', from: 1, to: 2 }]);
  assert.throws(() => pairCarries([{ id: 'a', names: ['x', 'x'] }]), /duplicate data-carry="x" in a/);
});

test('flightDuration never shorter than the window and never over maxPx/frame', () => {
  assert.equal(flightDuration(0, 0.6), 0.6);
  assert.equal(flightDuration(100, 0.6), 0.6);
  const d = flightDuration(1800, 0.6);
  assert.ok(d > 0.6);
  assert.ok((1800 / d) * peakSlope(CARRY_DEFAULTS.ease) / 30 <= 80 + 1e-6);
});

test('carryFrame: geometry ends exactly, crossfade only in the middle 30%, never see-through', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 }, b = { x: 400, y: 200, w: 200, h: 100 };
  assert.deepEqual(carryFrame(a, b, 0).box, a);
  assert.deepEqual(carryFrame(a, b, 1).box, b);
  for (const p of [0, 0.2, 0.35]) { const f = carryFrame(a, b, p); assert.equal(f.a, 1); assert.equal(f.b, 0); }
  for (const p of [0.65, 0.8, 1]) { const f = carryFrame(a, b, p); assert.equal(f.a, 0); assert.equal(f.b, 1); }
  for (let p = 0; p <= 1; p += 0.05) { const f = carryFrame(a, b, p); assert.ok(f.a + f.b >= 1 - 1e-9, `dip at ${p}`); }
});

test('cursorAt: one continuous path across boundaries, hide and re-appear', () => {
  const path = [
    { t0: 1, t1: 2, p: [100, 100] },
    { t0: 5, t1: 6, p: [900, 500] }, // e.g. next scene: flies from the last point, no jump
  ];
  assert.equal(cursorAt(path, 0.5), null);
  assert.deepEqual([cursorAt(path, 2).x, cursorAt(path, 2).y], [100, 100]);
  assert.deepEqual([cursorAt(path, 4).x, cursorAt(path, 4).y], [100, 100]);
  const mid = cursorAt(path, 5.5);
  assert.ok(mid.x > 100 && mid.x < 900);
  assert.equal(cursorAt(path, 4).o, 1);
  assert.equal(cursorAt(path, 3.5, [3]).o, 0);
  assert.equal(cursorAt(path, 5.5, [3]).o, 1);
});
