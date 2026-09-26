// npm test   (DOM-free: plain-object targets only)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../engine/timeline.js';
import { Graph, evalSpec, definePreset, defineOp } from '../engine/graph.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('existing tween/modify semantics unchanged', () => {
  const tl = new Timeline(), o = { x: 5, s: 1 };
  tl.to(o, { x: 10 }, { at: 1, dur: 1, ease: 'linear' });
  tl.modify(o, () => ({ x: 2 }));
  tl.seek(0); near(o.x, 7);
  tl.seek(1.5); near(o.x, 9.5);
  tl.seek(3); near(o.x, 12);
  tl.seek(1.5); near(o.x, 9.5); // seek is pure, no drift
});

test('keyframes, loop, stagger, clamp', () => {
  const g = { graph: null, gt: 0 };
  const k = { keys: [[0, 0], [1, 10, 'linear'], [2, 0, 'linear']] };
  near(evalSpec(k, { ...g, t: 0.5 }), 5);
  near(evalSpec(k, { ...g, t: 1.5 }), 5);
  near(evalSpec({ ...k, loop: 2 }, { ...g, t: 2.5 }), 5);
  near(evalSpec({ ...k, stagger: 0.5 }, { ...g, t: 1, i: 1 }), 5);
  assert.equal(evalSpec({ keys: [[0, 0], [1, 100, 'linear']], max: 30 }, { ...g, t: 1 }), 30);
  assert.deepEqual(evalSpec({ keys: [[0, [0, 0]], [1, [10, 20], 'linear']] }, { ...g, t: 0.5 }), [5, 10]);
});

test('behaviours are deterministic and seekable', () => {
  const s = { value: 0, fx: [{ type: 'noise', amp: 5, freq: 2, octaves: 3 }, { type: 'oscillate', amp: 1 }] };
  const a = evalSpec(s, { t: 1.234, i: 0 }), b = evalSpec(s, { t: 1.234, i: 0 });
  assert.equal(a, b);
  near(evalSpec({ value: 0, fx: [{ type: 'oscillate', amp: 2, freq: 1 }] }, { t: 0.25 }), 2);
  near(evalSpec({ value: 0, fx: [{ type: 'spring', to: 10, at: 0 }] }, { t: 20 }), 10, 1e-3);
  near(evalSpec({ value: 1, fx: [{ type: 'pulse', every: 1, amp: 1 }] }, { t: 3 }), 2);
  near(evalSpec({ value: 10, fx: [{ type: 'falloff', rest: 0 }] }, { t: 0, w: 0.25 }), 2.5);
});

test('channels, links, lag, expressions, live set', () => {
  const tl = new Timeline(), obj = { x: 0, y: 0, r: 0 };
  const g = new Graph(tl, { refs: { obj } });
  g.node({ id: 'lfo', type: 'channel', params: { v: { keys: [[0, 0], [2, 20, 'linear']] } } });
  g.node({ id: 'o', type: 'object', target: '@obj', params: {
    x: { link: 'lfo.v', mul: 2, add: 1 },
    y: { link: 'lfo.v', lag: 1 },
    r: { expr: 'ch("lfo.v") + t * 100' },
  } });
  tl.seek(1);
  near(obj.x, 21); near(obj.y, 0); near(obj.r, 110);
  g.set('lfo.v', 7);
  near(obj.x, 15);
  const ins = tl.inspect();
  assert.equal(ins.targets[0].target, 'o');
  assert.equal(ins.targets[0].mods[0].src, 'node:o');
  assert.equal(ins.graphs[0].items.length, 2);
});

test('add-mode layers on top of tweens; set-mode defaults to current value', () => {
  const tl = new Timeline(), o = { x: 0, scale: 1 };
  tl.to(o, { x: 100 }, { at: 0, dur: 1, ease: 'linear' });
  const g = new Graph(tl, { refs: { o } });
  g.node({ id: 'w', type: 'object', mode: 'add', target: '@o', params: { x: { fx: [{ type: 'step', every: 1, amount: 5 }] }, scale: { value: 1, expr: 'value * 2' } } });
  tl.seek(0.5); near(o.x, 50); near(o.scale, 2);
  tl.seek(2); near(o.x, 110);
  const tl2 = new Timeline(), p = { x: 3 };
  tl2.to(p, { x: 13 }, { at: 0, dur: 1, ease: 'linear' });
  new Graph(tl2, { refs: { p } }).node({ id: 'n', type: 'object', target: '@p', params: { x: { expr: 'value * 10' } } });
  tl2.seek(0.5); near(p.x, 80);
});

test('duplicator on a Space3D-like host with falloff', () => {
  class Host { constructor() { this.objs = []; } add(o) { this.objs.push(o); return o; } static box(w, h, d, o) { return { type: 'box', w, ...o }; } }
  const tl = new Timeline(), sp = new Host();
  const g = new Graph(tl, { refs: { sp } });
  g.node({ id: 'cubes', type: 'duplicator', space: '@sp', count: 9, shape: { type: 'box', args: [10, 10, 10] },
    distribution: { type: 'grid', cols: 3, spacing: [100, 100] },
    falloff: { type: 'radial', center: [0, 0], radius: 120, soft: 0.5 },
    params: { s: { value: 2, fx: [{ type: 'falloff', rest: 0.5 }] }, y: { expr: 'i * 10' } } });
  tl.seek(0);
  assert.equal(sp.objs.length, 9);
  near(sp.objs[4].x, 0); near(sp.objs[4].s, 2);            // center: full weight
  near(sp.objs[0].x, -100); near(sp.objs[0].s, 0.5, 1e-3); // corner (d=141 > r): rest
  near(sp.objs[5].y, 50);
  assert.equal(tl.nameOf(sp.objs[3]), 'cubes[3]');
});

test('operators and presets are traced and serializable', () => {
  const tl = new Timeline(), o = { x: 0, rotate: 0 };
  defineOp('nudge', { params: { dx: 10, at: 0, dur: 1 }, apply: (t, tgt, p) => t.to(tgt, { x: p.dx }, { at: p.at, dur: p.dur, ease: 'linear' }) });
  definePreset('nudgeTwice', { params: { dx: 5 }, items: [
    { kind: 'op', op: 'nudge', target: '{{target}}', params: { dx: '{{dx}}' } },
    { kind: 'node', type: 'object', mode: 'add', target: '{{target}}', params: { rotate: { expr: 't * {{dx}}' } } },
  ] });
  const g = new Graph(tl, { refs: { o } });
  g.preset({ preset: 'nudgeTwice', target: '@o', params: { dx: 40 } });
  tl.seek(1); near(o.x, 40); near(o.rotate, 40);
  const ins = tl.inspect();
  const tw = ins.targets[0].props.x[0];
  assert.equal(tw.src, 'preset:nudgeTwice > op:nudge');
  assert.deepEqual(ins.ops[0].params, { dx: 40, at: 0, dur: 1 });
  assert.deepEqual(g.toJSON().items, [{ kind: 'preset', preset: 'nudgeTwice', target: '@o', params: { dx: 40 } }]);
  // round-trip
  const tl2 = new Timeline(), o2 = { x: 0, rotate: 0 };
  Graph.fromJSON(tl2, g.toJSON(), { refs: { o: o2 } });
  tl2.seek(1); near(o2.x, 40); near(o2.rotate, 40);
  tl.op('nudge', o, { dx: 1, at: 5 });
  assert.equal(tl.ops.at(-1).op, 'nudge');
});

test('errors are explicit, not silent', () => {
  const tl = new Timeline(), g = new Graph(tl, { refs: {} });
  assert.throws(() => g.node({ id: 'a', type: 'object', target: '@missing' }), /unknown ref/);
  assert.throws(() => g.op({ op: 'nope', target: {} }), /unknown operator/);
  g.node({ id: 'c1', type: 'channel', params: { v: { link: 'c2.v' } } });
  g.node({ id: 'c2', type: 'channel', params: { v: { link: 'c1.v' } } });
  assert.throws(() => g.get('c1.v', 0), /cycle/);
  assert.throws(() => g.node({ id: 'c1', type: 'channel' }), /duplicate/);
});

test('stacked falloffs blend into w; envelopes are seekable lookups', async () => {
  const { registerEnvelope } = await import('../engine/ease.js');
  class Host { constructor() { this.objs = []; } add(o) { this.objs.push(o); return o; } static box(w, h, d, o) { return { type: 'box', ...o }; } }
  const tl = new Timeline(), sp = new Host();
  // index ramp × inverted index ramp → 0, 0.25, 0 across 3 clones
  new Graph(tl, { refs: { sp } }).node({ id: 'd', type: 'duplicator', space: '@sp', count: 3, shape: { type: 'box', args: [1, 1, 1] },
    distribution: { type: 'line', from: [0, 0], to: [2, 0] },
    falloff: [{ type: 'index', start: 0, end: 1 }, { type: 'index', start: 0, end: 1, invert: true, blend: 'multiply' }],
    params: { s: { value: 1, fx: [{ type: 'falloff', rest: 0 }] } } });
  tl.seek(0);
  const ws = sp.objs.map((o) => o.s);
  near(ws[0], 0, 1e-3); near(ws[1], 0.25, 0.05); near(ws[2], 0, 1e-3);
  assert.throws(() => new Graph(new Timeline(), { refs: { sp: new Host() } }).node({ id: 'x', type: 'duplicator', space: '@sp', count: 1,
    shape: { type: 'box', args: [1, 1, 1] }, falloff: [{ type: 'none' }, { type: 'none', blend: 'weird' }], params: { s: 1 } }), /unknown falloff blend/);
  // clamp:false lets stacked layers push weights past 1 (default still clamps to 0..1)
  const tlc = new Timeline(), hc = new Host(), tld = new Timeline(), hd = new Host();
  new Graph(tlc, { refs: { sp: hc } }).node({ id: 'u', type: 'duplicator', space: '@sp', count: 1, shape: { type: 'box', args: [1, 1, 1] },
    falloff: [{ type: 'none' }, { type: 'none', blend: 'add', clamp: false }], params: { s: { value: 1, fx: [{ type: 'falloff', rest: 0 }] } } });
  new Graph(tld, { refs: { sp: hd } }).node({ id: 'u', type: 'duplicator', space: '@sp', count: 1, shape: { type: 'box', args: [1, 1, 1] },
    falloff: [{ type: 'none' }, { type: 'none', blend: 'add' }], params: { s: { value: 1, fx: [{ type: 'falloff', rest: 0 }] } } });
  tlc.seek(0); tld.seek(0);
  near(hc.objs[0].s, 2, 1e-3); near(hd.objs[0].s, 1, 1e-3);
  registerEnvelope('kick', [0, 1, 0.5, 0], 2);
  near(evalSpec({ value: 0, fx: [{ type: 'envelope', name: 'kick', amp: 10 }] }, { t: 0.75, gt: 0.75, i: 0 }), 7.5);
  near(evalSpec({ value: 0, expr: 'env("kick") * 2' }, { t: 1, gt: 1, i: 0 }), 1);
  assert.throws(() => evalSpec({ value: 0, fx: [{ type: 'envelope', name: 'nope' }] }, { t: 0, gt: 0 }), /unknown envelope/);
});
