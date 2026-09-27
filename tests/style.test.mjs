// DOM-free: registry, resolution, pure filter markup, boil, animated params, rough settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, registerStyle, resolveStyle, styleMarkup, styleParams, roughAt, styleTransition, toRGB } from '../engine/style.js';
import { OPS } from '../engine/graph.js';

const BUILTIN = ['lineart', 'sketch', 'ink', 'watercolor', 'halftone', 'pixel', 'vhs', 'blueprint', 'cel', 'comic', 'duotone', 'riso', 'gameboy'];

test('built-ins exist and render well-formed markup', () => {
  for (const n of BUILTIN) assert.ok(STYLES[n], n);
  for (const n of Object.keys(STYLES)) {
    const m = styleMarkup(resolveStyle(n), { t: 1.3, W: 640, H: 360 });
    assert.ok(m.length > 50, n);
    assert.ok(!/undefined|NaN/.test(m), `${n}: ${m.match(/.{40}(undefined|NaN).{20}/)?.[0]}`);
    // every referenced input was produced earlier (or is a source)
    const made = new Set(['SourceGraphic', 'SourceAlpha']);
    for (const [, attr, v] of m.matchAll(/\b(in2?|result)="([^"]+)"/g)) {
      if (attr === 'result') made.add(v); else assert.ok(made.has(v), `${n}: "${v}" used before defined`);
    }
  }
  assert.equal(OPS.style.target, 'many');
});

test('resolveStyle: names, objects, stacks, none', () => {
  assert.deepEqual(resolveStyle('sketch'), [{ name: 'sketch', params: {} }]);
  assert.deepEqual(resolveStyle({ style: 'ink', weight: 3 }), [{ name: 'ink', params: { weight: 3 } }]);
  assert.deepEqual(resolveStyle('cel vhs').map((l) => l.name), ['cel', 'vhs']);
  assert.deepEqual(resolveStyle(['cel', { style: 'vhs', shift: 2 }])[1].params, { shift: 2 });
  assert.deepEqual(resolveStyle('{"style":"pixel","cell":4}'), [{ name: 'pixel', params: { cell: 4 } }]);
  for (const x of ['none', null, false, '']) assert.deepEqual(resolveStyle(x), []);
  assert.throws(() => resolveStyle('nope'), /unknown style "nope"/);
  assert.throws(() => resolveStyle({ weight: 1 }), /expected/);
});

test('markup is a pure function of t; boil re-seeds only per step', () => {
  const L = resolveStyle({ style: 'sketch', boil: 4 });
  const at = (t) => styleMarkup(L, { t, W: 800, H: 450 });
  assert.equal(at(1.3), at(1.3));
  assert.equal(at(1.0), at(1.2));       // same boil step (4/s → 0.25s)
  assert.notEqual(at(1.2), at(1.3));
  const still = resolveStyle({ style: 'lineart' });
  assert.equal(styleMarkup(still, { t: 0 }), styleMarkup(still, { t: 9 }));
});

test('params accept animation specs; mix fades to source; stacks chain', () => {
  const L = resolveStyle({ style: 'lineart', weight: { keys: [[0, 1], [2, 3, 'linear']] } });
  assert.equal(styleParams(L[0], { t: 1 }).weight, 2);
  assert.equal(styleMarkup(resolveStyle({ style: 'cel', mix: 0 }), { t: 0, W: 1920, H: 1080 }), '');
  assert.match(styleMarkup(resolveStyle({ style: 'cel', mix: 0.5 }), { t: 0, W: 1920, H: 1080 }), /k2="0.5" k3="0.5"/);
  assert.equal(styleMarkup(resolveStyle('cel'), { t: 0, W: 1920, H: 1080, mix: 0 }), '');
  const m = styleMarkup(resolveStyle('cel vhs'), { t: 0, W: 1920, H: 1080 });
  assert.match(m, /result="s0_out"/);      // first layer produces output
  assert.match(m, /in="s0_out"/);          // second layer reads the first
  assert.match(styleMarkup(resolveStyle('cel'), { t: 0, W: 1920, H: 1080, clip: true }), /operator="in"\/>$/);
});

test('registerStyle: extends, validation', () => {
  registerStyle('test-soft', { extends: 'lineart', params: { weight: 4, ink: '#123456' } });
  assert.equal(STYLES['test-soft'].params.weight, 4);
  assert.equal(STYLES['test-soft'].params.paper, STYLES.lineart.params.paper);
  assert.match(styleMarkup(resolveStyle('test-soft'), { t: 0 }), /rgb\(18,52,86\)/);
  assert.throws(() => registerStyle('x', { params: {} }), /needs filter/);
  assert.throws(() => registerStyle('y', { extends: 'nope' }), /unknown style/);
  delete STYLES['test-soft'];
});

test('rough settings for Space3D: optional, scaled, boiled', () => {
  assert.equal(roughAt(resolveStyle('vhs'), { t: 0, W: 1920, H: 1080 }), null);
  assert.equal(roughAt(resolveStyle({ style: 'sketch', rough: 0 }), { t: 0, W: 1920, H: 1080 }), null);
  const a = roughAt(resolveStyle({ style: 'sketch', boil: 2 }), { t: 0.1, W: 1920, H: 1080 });
  const b = roughAt(resolveStyle({ style: 'sketch', boil: 2 }), { t: 0.6, W: 1920, H: 1080 });
  assert.ok(a.amp > 0 && a.passes === 2);
  assert.notEqual(a.seed, b.seed);
  assert.ok(roughAt(resolveStyle({ style: 'sketch', mix: 0.5 }), { t: 0, W: 1920, H: 1080 }).amp < a.amp);
});

test('style transitions resolve by name', () => {
  assert.equal(typeof styleTransition({ type: 'sketch-in' }), 'function');
  assert.equal(typeof styleTransition({ type: 'style', style: { style: 'ink' } }), 'function');
  assert.equal(styleTransition({ type: 'fade' }), null);
  assert.equal(styleTransition({ type: 'nope-in' }), null);
});

test('colors', () => {
  assert.deepEqual(toRGB('#fff'), [1, 1, 1]);
  assert.deepEqual(toRGB('rgb(255, 0, 0)'), [1, 0, 0]);
  assert.throws(() => toRGB('red'), /unsupported color/);
});
