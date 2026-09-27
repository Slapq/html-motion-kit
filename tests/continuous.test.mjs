// DOM-free: ease strictness, peak slope, chapter layout and camera speed limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEase, peakSlope, ease } from '../engine/ease.js';
import { planChapters, cameraAt, moveDuration } from '../engine/continuous.js';

test('unknown ease names throw instead of silently falling back', () => {
  assert.throws(() => resolveEase('inOutSin'), /unknown ease "inOutSin"/);
  assert.equal(resolveEase(undefined), ease.outCubic);
  for (const n of ['inSine', 'outSine', 'inOutSine']) assert.equal(resolveEase(n)(1).toFixed(6), '1.000000');
});

test('peakSlope matches the known derivative peaks', () => {
  assert.ok(Math.abs(peakSlope('linear') - 1) < 0.01);
  assert.ok(Math.abs(peakSlope('inOutQuad') - 2) < 0.01);
  assert.ok(Math.abs(peakSlope('inOutCubic') - 3) < 0.01);
  assert.ok(Math.abs(peakSlope('inOutSine') - Math.PI / 2) < 0.01);
});

test('moveDuration keeps 1920px under 80px/frame at 30fps', () => {
  assert.equal(moveDuration(1920, { fps: 30, ease: 'inOutQuad' }), 1.6);
  assert.equal(moveDuration(1920, { fps: 30, ease: 'inOutCubic' }), 2.4);
  assert.equal(moveDuration(100, { fps: 30 }), 0.9); // floor
});

test('planChapters: offsets, windows, camera never static and never too fast', () => {
  const p = planChapters([{ id: 'a', dur: 4.6 }, { id: 'b', dur: 5 }, { id: 'c', dur: 5.6 }], { width: 1920, fps: 30 });
  assert.equal(p.duration, 15.2);
  assert.equal(p.worldWidth, 5760);
  assert.deepEqual(p.chapters.map((c) => c.left), [0, 1920, 3840]);
  assert.deepEqual(p.chapters.map((c) => c.start), [0, 4.6, 9.6]);
  assert.deepEqual(p.chapters.map((c) => c.arrive), [0, 1.6, 1.6]);
  const dt = 1 / 30;
  let maxStep = 0, minStep = Infinity;
  for (let t = dt; t <= p.duration; t += dt) {
    const d = Math.abs(cameraAt(p.keys, t) - cameraAt(p.keys, t - dt));
    maxStep = Math.max(maxStep, d); minStep = Math.min(minStep, d);
  }
  assert.ok(maxStep <= 80.5, `max ${maxStep}px/frame`);
  assert.ok(minStep > 0.2, `camera stalls: min ${minStep}px/frame`);
  // lands exactly on each chapter
  assert.equal(Math.round(cameraAt(p.keys, 4.6 + 1.6)), -1920);
});

test('planChapters rejects chapters shorter than the camera move and bad eases', () => {
  assert.throws(() => planChapters([{ dur: 3 }, { dur: 1 }]), /shorter than the camera move/);
  assert.throws(() => planChapters([{ dur: 0 }]), /dur must be > 0/);
  assert.throws(() => planChapters([{ dur: 3 }], { camera: { ease: 'smooth' } }), /unknown ease/);
});
