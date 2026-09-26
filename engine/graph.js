// Data-driven node graph (TouchDesigner / Cavalry style) on top of Timeline.
//
// Everything is plain JSON, so every effect is reusable, every motion is traceable,
// and every model (DOM layer, Space3D object, camera, puppet) is manipulable.
//
//   const g = new Graph(tl, { root: el, refs: { sp, route, puppet } });
//   g.node({ id: 'lfo', type: 'channel', params: { v: { fx: [{ type: 'oscillate', amp: 1, freq: 0.5 }] } } });
//   g.node({ id: 'title', type: 'layer', target: '.title',
//            params: { y: { keys: [[0, 80], [0.8, 0, 'outBack']] }, rotate: { link: 'lfo.v', mul: 4 } } });
//   g.node({ id: 'dots', type: 'duplicator', parent: '.grid', html: '<i class="dot"></i>', count: 48,
//            distribution: { type: 'grid', cols: 12, spacing: [60, 60] },
//            falloff: { type: 'radial', center: { expr: '[960 + sin(t) * 400, 540]' }, radius: 360 },
//            params: { scale: { value: 1, fx: [{ type: 'falloff', rest: 0.2 }] } } });
//   g.toJSON() / Graph.fromJSON(tl, json, { root, refs })
//
// Param spec (any param of any node):
//   3 | 'red' | [1, 2]                       constant
//   { value, keys: [[t, v, ease?]], loop, delay, stagger,   keyframes (node-local time)
//     link: 'node.param', lag, mul, add,                     reference another node (TD-style)
//     fx: [{ type: 'noise' | 'oscillate' | 'spring' | 'pulse' | 'step' | 'random' | 'falloff' | 'quantize' | 'math', ... }],
//     expr: 'value + sin(t * 2) * 10 * w',                   expression (t lt i n u w px py value ch() ...)
//     min, max }
import { resolveEase, lerp, clamp, noise, rng, envAt } from './ease.js';
import { Timeline, DEFAULTS, MULTIPLY } from './timeline.js';

const hash = (i, seed) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
const mix = (a, b, p) => (Array.isArray(a) ? a.map((x, k) => lerp(x, b[k] ?? x, p)) : typeof a === 'number' && typeof b === 'number' ? lerp(a, b, p) : p < 1 ? a : b);
const isSpec = (s) => s && typeof s === 'object' && !Array.isArray(s);

// ---------------------------------------------------------------- behaviours
// (value, ctx, opts) -> value. Pure functions of ctx.t, so fully seekable.
export const BEHAVIOURS = {
  noise: (v, c, o) => {
    const f = o.freq ?? 1, a = o.amp ?? 1, s = (o.seed ?? 1) + c.i * 17.3;
    let n = 0, amp = 1, fr = f, tot = 0;
    for (let k = 0; k < (o.octaves ?? 1); k++) { n += noise(c.t * fr, s + k * 5) * amp; tot += amp; amp *= 0.5; fr *= 2; }
    return v + (n / tot) * a;
  },
  oscillate: (v, c, o) => {
    const p = c.t * (o.freq ?? 1) + (o.phase ?? 0) + c.i * (o.offset ?? 0), a = o.amp ?? 1, f = p - Math.floor(p);
    const w = { sine: Math.sin(p * 2 * Math.PI), tri: 1 - 4 * Math.abs(f - 0.5), square: f < 0.5 ? 1 : -1, saw: f * 2 - 1 }[o.shape || 'sine'];
    return v + w * a;
  },
  // Damped spring from the incoming value to `to`, released at `at`.
  spring: (v, c, o) => {
    const t = c.t - (o.at ?? 0) - c.i * (o.stagger ?? 0);
    if (t <= 0) return v;
    const k = o.stiffness ?? 8, z = o.damping ?? 0.35;
    const p = 1 - Math.exp(-z * k * t) * Math.cos(k * Math.sqrt(Math.max(0, 1 - z * z)) * t);
    return lerp(v, o.to ?? 0, p);
  },
  // Decaying pulse every `every` seconds (or at `bpm`) — beat-synced accents.
  pulse: (v, c, o) => {
    const every = o.every ?? 60 / (o.bpm ?? 120), t = c.t - (o.offset ?? 0);
    if (t < 0) return v;
    return v + (o.amp ?? 1) * Math.exp(-((t % every) / every) * (o.decay ?? 7));
  },
  step: (v, c, o) => v + Math.floor(Math.max(0, c.t) / (o.every ?? 1)) * (o.amount ?? 1),
  random: (v, c, o) => v + lerp(o.min ?? -1, o.max ?? 1, hash(c.i + 1, o.seed ?? 3)),
  falloff: (v, c, o) => lerp(o.rest ?? 0, v, o.invert ? 1 - c.w : c.w),
  quantize: (v, c, o) => Math.round(v / (o.step ?? 1)) * (o.step ?? 1),
  // Audio-reactive (TD Audio Analysis CHOP): envelope pre-computed by analyzeAudio(), looked up by time.
  envelope: (v, c, o) => v + envAt(o.name + (o.band ? '.' + o.band : ''), c.gt - (o.lag ?? 0) - c.i * (o.offset ?? 0)) * (o.amp ?? 1),
  math: (v, c, o) => Math.pow(Math.abs(v * (o.mul ?? 1) + (o.add ?? 0)), o.pow ?? 1) * Math.sign(v * (o.mul ?? 1) + (o.add ?? 0) || 1),
};
export const registerBehaviour = (name, fn) => { BEHAVIOURS[name] = fn; };

// ---------------------------------------------------------------- expressions
const EXPR_SCOPE = Object.fromEntries(['sin', 'cos', 'tan', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'sqrt', 'pow', 'exp', 'log', 'sign', 'atan2', 'hypot', 'PI']
  .map((k) => [k, Math[k]]));
Object.assign(EXPR_SCOPE, { lerp, clamp, noise, hash, TAU: Math.PI * 2 });
const envFn = (gt) => (name, lag = 0) => envAt(name, gt - lag);
const exprCache = new Map();
// Expressions come from project files (same trust level as the project's own JS).
function compile(src) {
  let f = exprCache.get(src);
  if (!f) { f = new Function('$', `with ($) { return (${src}); }`); exprCache.set(src, f); }
  return f;
}

// Keyframes: [[t, v, ease?], ...] or [{ t, v, ease }]; ease applies to the segment arriving at the key.
function keyAt(keys, t) {
  const K = keys.map((k) => (Array.isArray(k) ? { t: k[0], v: k[1], ease: k[2] } : k));
  if (t <= K[0].t) return K[0].v;
  for (let j = 1; j < K.length; j++) {
    if (t < K[j].t) return mix(K[j - 1].v, K[j].v, resolveEase(K[j].ease || 'inOutCubic')(clamp((t - K[j - 1].t) / (K[j].t - K[j - 1].t))));
  }
  return K[K.length - 1].v;
}

// Evaluate a param spec. ctx: { t, i, n, u, w, px, py, pz, angle, graph, node, def }
export function evalSpec(spec, ctx) {
  if (!isSpec(spec)) return spec ?? ctx.def;
  let t = ctx.t - (spec.delay ?? 0) - (ctx.i || 0) * (spec.stagger ?? 0);
  if (spec.loop && t > 0) t %= spec.loop;
  const c = t === ctx.t && ctx.i != null ? ctx : { ...ctx, t, i: ctx.i ?? 0 };
  let v = spec.value ?? ctx.def;
  if (spec.keys?.length) v = keyAt(spec.keys, c.t);
  if (spec.link) {
    const lv = ctx.graph.get(spec.link, ctx.gt - (spec.lag ?? 0), ctx);
    v = typeof lv === 'number' ? lv * (spec.mul ?? 1) + (spec.add ?? 0) : lv;
  }
  if (spec.fx) for (const b of spec.fx) {
    const fn = BEHAVIOURS[b.type];
    if (!fn) throw new Error(`unknown behaviour "${b.type}"`);
    if (typeof v === 'number') v = fn(v, c, b);
  }
  if (spec.expr != null) v = compile(spec.expr)({ ...EXPR_SCOPE, ...c, value: v, ch: (p, lag = 0) => ctx.graph.get(p, ctx.gt - lag, ctx), env: envFn(ctx.gt ?? c.t) });
  if (typeof v === 'number') { if (spec.min != null) v = Math.max(spec.min, v); if (spec.max != null) v = Math.min(spec.max, v); }
  return v;
}
// ---------------------------------------------------------------- distributions (Cavalry)
// (opts, n) -> [{ px, py, pz, angle }]
export const DISTRIBUTIONS = {
  grid: (o, n) => {
    const cols = o.cols ?? Math.ceil(Math.sqrt(n)), rows = o.rows ?? Math.ceil(n / cols), [sx, sy] = o.spacing ?? [60, 60], [cx, cy] = o.center ?? [0, 0];
    return Array.from({ length: n }, (_, i) => ({ px: cx + ((i % cols) - (cols - 1) / 2) * sx, py: cy + (Math.floor(i / cols) - (rows - 1) / 2) * sy, pz: 0 }));
  },
  grid3: (o, n) => {
    const [c, r, l] = o.dims ?? [5, 5, 5], [sx, sy, sz] = o.spacing ?? [200, 200, 200];
    return Array.from({ length: n }, (_, i) => ({ px: ((i % c) - (c - 1) / 2) * sx, py: ((Math.floor(i / c) % r) - (r - 1) / 2) * sy, pz: (Math.floor(i / (c * r)) - (l - 1) / 2) * sz }));
  },
  line: (o, n) => {
    const a = o.from ?? [-400, 0, 0], b = o.to ?? [400, 0, 0];
    return Array.from({ length: n }, (_, i) => { const u = n > 1 ? i / (n - 1) : 0.5; return { px: lerp(a[0], b[0], u), py: lerp(a[1], b[1], u), pz: lerp(a[2] ?? 0, b[2] ?? 0, u) }; });
  },
  circle: (o, n) => {
    const r = o.radius ?? 300, [cx, cy] = o.center ?? [0, 0], a0 = ((o.start ?? -90) * Math.PI) / 180, arc = ((o.arc ?? 360) * Math.PI) / 180;
    const div = (o.arc ?? 360) >= 360 ? n : Math.max(1, n - 1);
    return Array.from({ length: n }, (_, i) => { const a = a0 + (arc * i) / div; return { px: cx + Math.cos(a) * r, py: cy + Math.sin(a) * r, pz: 0, angle: (a * 180) / Math.PI + 90 }; });
  },
  spiral: (o, n) => {
    const r = o.radius ?? 400, turns = o.turns ?? 3, [cx, cy] = o.center ?? [0, 0];
    return Array.from({ length: n }, (_, i) => { const u = i / Math.max(1, n - 1), a = u * turns * Math.PI * 2; return { px: cx + Math.cos(a) * r * u, py: cy + Math.sin(a) * r * u, pz: (o.rise ?? 0) * u, angle: (a * 180) / Math.PI }; });
  },
  random: (o, n) => {
    const r = rng(o.seed ?? 11), [w, h, d = 0] = o.bounds ?? [1600, 900], [cx, cy] = o.center ?? [0, 0];
    return Array.from({ length: n }, () => ({ px: cx + (r() - 0.5) * w, py: cy + (r() - 0.5) * h, pz: (r() - 0.5) * d }));
  },
  points: (o, n) => Array.from({ length: n }, (_, i) => { const p = o.points[i % o.points.length]; return { px: p[0], py: p[1], pz: p[2] ?? 0 }; }),
};
export const registerDistribution = (name, fn) => { DISTRIBUTIONS[name] = fn; };

// ---------------------------------------------------------------- falloffs (Cavalry)
// (opts, ctx) -> weight 0..1. Options may themselves be param specs (animated centers, sweeps).
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
export const FALLOFFS = {
  none: () => 1,
  radial: (o, c, E) => {
    const [cx, cy] = E(o.center, [0, 0]), r = E(o.radius, 300), soft = E(o.soft, 0.6);
    return 1 - sstep(r * (1 - soft), r, Math.hypot(c.px - cx, c.py - cy));
  },
  linear: (o, c, E) => {
    const a = (E(o.angle, 0) * Math.PI) / 180, s = c.px * Math.cos(a) + c.py * Math.sin(a);
    return sstep(0, E(o.width, 300), s - E(o.offset, 0));
  },
  index: (o, c, E) => sstep(E(o.start, 0), E(o.end, 1), c.u),
  noise: (o, c, E) => noise(c.px * E(o.scale, 0.004) + c.t * E(o.speed, 0.4), (o.seed ?? 1) + c.py * E(o.scale, 0.004) * 7.1) * 0.5 + 0.5,
};
export const registerFalloff = (name, fn) => { FALLOFFS[name] = fn; };
const BLENDS = { multiply: (a, b) => a * b, add: (a, b) => a + b, subtract: (a, b) => a - b, max: Math.max, min: Math.min, screen: (a, b) => 1 - (1 - a) * (1 - b) };

// ---------------------------------------------------------------- operators & presets
// Operator: an effect with a typed, JSON-serializable parameter schema.
//   defineOp('shake', { params: { dur: 0.4, amp: 14 }, apply: (tl, target, p) => fx.shake(tl, target, p) })
export const OPS = {};
export const defineOp = (name, def) => { OPS[name] = { params: {}, ...def }; return OPS[name]; };

// Preset: a reusable bundle of graph items with {{placeholders}}.
//   definePreset('wobble', { params: { amp: 6 }, items: [{ kind: 'node', type: 'layer', target: '{{target}}', mode: 'add',
//     params: { rotate: { fx: [{ type: 'noise', amp: '{{amp}}' }] } } }] })
export const PRESETS = {};
export const definePreset = (name, def) => { PRESETS[name] = { params: {}, items: [], ...def }; return PRESETS[name]; };
function fill(x, p) {
  if (typeof x === 'string') {
    const m = x.match(/^\{\{(\w+)\}\}$/);
    if (m) return p[m[1]];
    return x.replace(/\{\{(\w+)\}\}/g, (_, k) => p[k]);
  }
  if (Array.isArray(x)) return x.map((y) => fill(y, p));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v, p)]));
  return x;
}
// {{name}} placeholders anywhere in a JSON-ish value (also used for video props). Unknown names are kept verbatim.
export const fillTemplate = (x, p) => fill(x, new Proxy(p, { get: (o, k) => (k in o ? o[k] : `{{${String(k)}}}`) }));
const isEl = (o) => typeof Element !== 'undefined' && o instanceof Element;
const snap = (o, params) => Object.fromEntries(Object.keys(params || {}).map((k) => [k, o[k]]));

// ---------------------------------------------------------------- graph
// Node kinds: channel (virtual CHOP), layer (DOM), object (any ref: Space3D object/camera, puppet.params, plain obj),
// duplicator (Cavalry: distribution x falloff → DOM clones or Space3D objects).
export class Graph {
  constructor(tl, { root = globalThis.document, refs = {}, stage } = {}) {
    Object.assign(this, { tl, root, refs, stage: stage || root, nodes: new Map(), items: [] });
    (tl._root.graphs ||= []).push(this);
    this._depth = 0;
  }
  resolve(q) {
    if (q == null) return [];
    if (typeof q !== 'string') return Array.isArray(q) ? q : [q];
    if (q[0] === '@') {
      const [k, ...path] = q.slice(1).split('.');
      let o = this.refs[k];
      for (const p of path) o = o?.[p];
      if (o == null) throw new Error(`graph: unknown ref "${q}"`);
      return Array.isArray(o) ? o : [o];
    }
    const els = [...(this.root?.querySelectorAll ? this.root : document).querySelectorAll(q)];
    if (!els.length) throw new Error(`graph: selector "${q}" matched nothing`);
    return els;
  }
  // Read a channel: 'node.param' (node-local time) or '@ref.prop' (current value).
  get(path, gt = this.tl._root.time ?? 0, ctx = {}) {
    if (path[0] === '@') return this.resolve(path)[0];
    const dot = path.indexOf('.'), id = path.slice(0, dot), key = path.slice(dot + 1);
    const n = this.nodes.get(id);
    if (!n) throw new Error(`graph: unknown node "${id}" in link "${path}"`);
    if (++this._depth > 32) { this._depth = 0; throw new Error(`graph: link cycle at "${path}"`); }
    try {
      return evalSpec(n.params?.[key], { ...ctx, t: gt - n._g0, gt, graph: this, node: n, def: 0 });
    } finally { this._depth--; }
  }
  // Live manipulation: g.set('title.y', 20) or g.set('title.y', { keys: [...] }); next seek reflects it.
  set(path, spec) {
    const dot = path.indexOf('.'), n = this.nodes.get(path.slice(0, dot));
    if (!n) throw new Error(`graph: unknown node in "${path}"`);
    (n.params ||= {})[path.slice(dot + 1)] = spec;
    this.tl._root.seek?.(this.tl._root.time ?? 0);
    return this;
  }
  add(items) { for (const it of [].concat(items)) this[it.kind === 'op' ? 'op' : it.kind === 'preset' ? 'preset' : 'node'](it); return this; }

  node(spec) {
    const n = { type: 'layer', mode: 'set', ...spec };
    n.id ||= `${n.type}${this.nodes.size + 1}`;
    if (this.nodes.has(n.id)) throw new Error(`graph: duplicate node id "${n.id}"`);
    this.nodes.set(n.id, n);
    this.items.push({ kind: 'node', spec });
    const tl = this.tl, t0 = tl._t(n.at ?? 0);
    n._g0 = tl._o + t0;
    const label = `node:${n.id}`, opt = { at: t0, dur: n.dur, mode: n.mode, label };
    if (n.type === 'channel') { if (n.dur) tl._mark(t0, t0 + n.dur); return n; }
    if (n.type === 'duplicator') return this._dup(n, opt);
    const targets = this.resolve(n.target);
    targets.forEach((target, i) => {
      const base = isEl(target) ? null : snap(target, n.params);
      if (targets.length === 1) tl.name(target, n.id); else tl.name(target, `${n.id}[${i}]`);
      tl.modify(target, (lt, gt, cur) => this._params(n, { t: lt, gt, cur, base, i, n: targets.length, u: targets.length > 1 ? i / (targets.length - 1) : 0, w: 1, px: 0, py: 0, pz: 0 }), opt);
    });
    if (n.dur) tl._mark(t0, t0 + n.dur);
    return n;
  }
  _params(n, ctx, out = {}) {
    ctx.graph = this; ctx.node = n;
    // add-mode neutral element: 1 for multiplied props (scale/opacity...), 0 otherwise; set-mode: rest value.
    for (const k in n.params || {}) {
      ctx.def = n.mode === 'add' ? (MULTIPLY.has(k) ? 1 : 0) : ctx.cur?.[k] ?? (ctx.base ? ctx.base[k] : DEFAULTS[k]) ?? 0;
      out[k] = evalSpec(n.params[k], ctx);
      if (out[k] === undefined) delete out[k];
    }
    return out;
  }
  _dup(n, opt) {
    const tl = this.tl, count = n.count ?? 10, d = n.distribution || { type: 'grid' };
    const dist = DISTRIBUTIONS[d.type];
    if (!dist) throw new Error(`graph: unknown distribution "${d.type}"`);
    const pts = dist(d, count);
    let targets;
    if (n.space) {
      const sp = this.resolve(n.space)[0], sh = n.shape || { type: 'box', args: [40, 40, 40] }, S = sp.constructor;
      targets = pts.map(() => sp.add(S[sh.type](...(sh.args || []), { ...(sh.opts || {}) })));
    } else {
      const parent = this.resolve(n.parent || this.stage)[0];
      targets = pts.map((_, i) => {
        const h = document.createElement('div');
        h.innerHTML = typeof n.html === 'function' ? n.html(i) : (n.html || '<i></i>').replace(/\{\{i\}\}/g, i);
        const el = h.firstElementChild;
        el.classList.add('dup-item');
        el.dataset.node = `${n.id}[${i}]`;
        parent.appendChild(el);
        return el;
      });
    }
    n._targets = targets; n._dup = true; n.mode = 'set';
    const bases = targets.map((t) => (isEl(t) ? null : snap(t, n.params)));
    const fos = [].concat(n.falloff || { type: 'none' });
    for (const f of fos) {
      if (!FALLOFFS[f.type]) throw new Error(`graph: unknown falloff "${f.type}"`);
      if (f.blend && !BLENDS[f.blend]) throw new Error(`graph: unknown falloff blend "${f.blend}"`);
    }
    // Stacked falloffs (Cavalry / C4D effector fields): each layer blends into w with add|multiply|max|min|subtract, optional invert/strength; clamp:false lets a layer push weights outside 0..1.
    const weight = (ctx) => fos.reduce((w, f, k) => {
      let x = FALLOFFS[f.type](f, ctx, (s, def) => evalSpec(s, { ...ctx, def }));
      if (f.invert) x = 1 - x;
      x *= f.strength ?? 1;
      if (k === 0) return x;
      const r = BLENDS[f.blend || 'multiply'](w, x);
      return f.clamp === false ? r : clamp(r);
    }, 1);
    targets.forEach((target, i) => {
      tl.name(target, `${n.id}[${i}]`);
      const p = pts[i], u = count > 1 ? i / (count - 1) : 0;
      tl.modify(target, (lt, gt, cur) => {
        const ctx = { t: lt, gt, cur, base: bases[i], i, n: count, u, px: p.px, py: p.py, pz: p.pz, angle: p.angle ?? 0, graph: this, node: n };
        ctx.w = weight(ctx);
        const o = this._params(n, ctx);
        o.x = p.px + (o.x ?? 0); o.y = p.py + (o.y ?? 0);
        if (n.space) o.z = p.pz + (o.z ?? 0);
        if (n.align && !n.space) o.rotate = ctx.angle + (o.rotate ?? 0);
        return o;
      }, { ...opt, mode: 'set' });
    });
    if (n.dur) tl._mark(tl._t(n.at ?? 0), tl._t(n.at ?? 0) + n.dur);
    return n;
  }

  op(spec) {
    const { op, target, params = {} } = spec, def = OPS[op];
    if (!def) throw new Error(`graph: unknown operator "${op}"`);
    const p = { ...def.params, ...params };
    const tgt = def.target === 'none' ? null : def.target === 'many' ? this.resolve(target) : this.resolve(target)[0];
    const label = `op:${op}${spec.id ? '#' + spec.id : ''}`;
    this.tl.trace(label, (tl) => def.apply(tl, tgt, p, this));
    const rec = { op, target: typeof target === 'string' ? target : this.tl.nameOf(tgt), params: p, at: this.tl._o, id: spec.id };
    this.tl._root.ops.push(rec);
    this.items.push({ kind: 'op', spec });
    return rec;
  }
  preset(spec) {
    const def = PRESETS[spec.preset];
    if (!def) throw new Error(`graph: unknown preset "${spec.preset}"`);
    const p = { ...def.params, ...spec.params, target: spec.target, id: spec.id || spec.preset };
    const before = this.items.length;
    this.tl.trace(`preset:${spec.preset}`, () => this.add(fill(def.items, p).map((it, k) => (it.kind === 'op' || it.id ? it : { ...it, id: `${p.id}.${k}` }))));
    this.items.splice(before, Infinity, { kind: 'preset', spec });
  }

  toJSON() {
    const clean = (s) => JSON.parse(JSON.stringify(s, (k, v) => (typeof v === 'function' ? `[fn ${v.name || 'anonymous'}]` : isEl(v) ? `[el ${this.tl.nameOf(v)}]` : v)));
    return { items: this.items.map((it) => ({ kind: it.kind, ...clean(it.spec) })) };
  }
  static fromJSON(tl, json, opts) { return new Graph(tl, opts).add((json.items || json).map((it) => ({ ...it }))); }
}

// tl.op('shake', el, { amp: 10 }) — apply a registered operator, traced.
export function applyOp(tl, op, target, params, env) {
  return new Graph(tl, env || {}).op({ op, target, params });
}
// ---------------------------------------------------------------- built-in operators
// Every fx.* preset is also an operator with a declared schema → usable from JSON.
import * as fx from './effects.js';
const at0 = { at: '+0' };
defineOp('tween', { params: { from: null, to: null, at: '+0', dur: 0.6, ease: 'outCubic' }, apply: (tl, t, p) => {
  const o = { at: p.at, dur: p.dur, ease: p.ease };
  if (p.from && p.to) tl.fromTo(t, p.from, p.to, o); else if (p.from) tl.from(t, p.from, o); else tl.to(t, p.to || {}, o);
} });
defineOp('set', { params: { props: {}, at: '+0' }, apply: (tl, t, p) => tl.set(t, p.props, { at: p.at }) });
defineOp('textIn', { params: { ...at0, preset: 'rise', by: 'char', stagger: 0.035, dur: 0.6, sfx: null }, apply: (tl, t, p) => fx.textIn(tl, t, p) });
defineOp('typewriter', { params: { ...at0, cps: 22, sfx: 'type', sfxEvery: 2, caret: true }, apply: (tl, t, p) => fx.typewriter(tl, t, p) });
defineOp('counter', { params: { ...at0, from: 0, to: 100, dur: 1.5, ease: 'outExpo', decimals: 0, sfx: 'tick', ticks: 12 }, apply: (tl, t, p) => fx.counter(tl, t, p) });
defineOp('staggerIn', { target: 'many', params: { ...at0, stagger: 0.08, dur: 0.6, from: { y: 30, opacity: 0 }, ease: 'outCubic', sfx: null }, apply: (tl, t, p) => fx.staggerIn(tl, t, p) });
defineOp('kenBurns', { params: { at: 0, dur: 8, fromScale: 1.08, toScale: 1.22, x: [-20, 20], y: [10, -10] }, apply: (tl, t, p) => fx.kenBurns(tl, t, p) });
defineOp('float', { params: { amp: 10, speed: 0.4, rot: 1.5, seed: 1 }, apply: (tl, t, p) => fx.float(tl, t, p) });
defineOp('shake', { params: { at: '<', dur: 0.4, amp: 14 }, apply: (tl, t, p) => fx.shake(tl, t, p) });
defineOp('drawPath', { params: { ...at0, dur: 1.2, stagger: 0.1, ease: 'inOutCubic' }, apply: (tl, t, p) => fx.drawPath(tl, t, p) });
defineOp('scramble', { params: { ...at0, dur: 1, seed: 5, sfx: 'blip', fps: 30 }, apply: (tl, t, p) => fx.scramble(tl, t, p) });
defineOp('glitch', { params: { ...at0, dur: 0.5, amp: 12, colors: ['#ff2e88', '#c6ff00'], seed: 9 }, apply: (tl, t, p) => fx.glitch(tl, t, p) });
defineOp('highlight', { params: { ...at0, dur: 1.6, pad: 12, color: 'var(--accent)' }, apply: (tl, t, p, g) => fx.highlight(tl, g.stage, t, p) });
defineOp('particles', { target: 'none', params: { mode: 'dust', at: 0, count: 80, color: '#ffffff', colors: null, seed: 3, origin: [0.5, 0.5], dur: null, z: 1, sfx: undefined },
  apply: (tl, t, p, g) => fx.particles(tl, g.stage, { ...p, colors: p.colors || undefined, dur: p.dur ?? Infinity }) });
defineOp('emote', { params: { name: 'nod', at: 0, dur: 0.8 }, apply: (tl, t, p) => t.emote(p.name, tl._t(p.at), p.dur) }); // puppet time = scene-local (puppet.update(lt))
defineOp('talk', { params: { at: 0, dur: 2 }, apply: (tl, t, p) => { const s = tl._t(p.at); t.talk(s, s + p.dur); } });
defineOp('sfx', { target: 'none', params: { name: 'soft', at: '<', opts: {} }, apply: (tl, t, p) => tl.sfx(p.name, p.at, p.opts) });
defineOp('caption', { target: 'none', params: { text: '', at: '+0', dur: 3 }, apply: (tl, t, p) => tl.caption(p.text, p.at, p.dur) });

// Built-in presets (data only — copy them as templates).
definePreset('wobble', { params: { amp: 4, freq: 0.6, seed: 1 }, items: [
  { kind: 'node', type: 'layer', mode: 'add', target: '{{target}}', params: { rotate: { fx: [{ type: 'noise', amp: '{{amp}}', freq: '{{freq}}', seed: '{{seed}}' }] } } },
] });
definePreset('beatPulse', { params: { bpm: 120, amp: 0.06, decay: 7, offset: 0 }, items: [
  { kind: 'node', type: 'layer', mode: 'add', target: '{{target}}', params: { scale: { value: 1, fx: [{ type: 'pulse', bpm: '{{bpm}}', amp: '{{amp}}', decay: '{{decay}}', offset: '{{offset}}' }] } } },
] });
definePreset('popIn', { params: { at: 0, dur: 0.5, stagger: 0.06 }, items: [
  { kind: 'op', op: 'staggerIn', target: '{{target}}', params: { at: '{{at}}', dur: '{{dur}}', stagger: '{{stagger}}', from: { scale: 0, opacity: 0 }, ease: 'outBack' } },
] });

// Timeline sugar: tl.op('shake', el, { amp: 8 }), tl.graph({ refs }) → Graph bound to this scope.
Timeline.prototype.op = function (name, target, params, env) { applyOp(this, name, target, params, env); return this; };
Timeline.prototype.graph = function (env = {}) { return new Graph(this, env); };
