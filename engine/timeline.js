// Seekable timeline. Every visual value is a pure function of time, so the
// player can jump to any frame (scrubbing, frame-exact export) without drift.
//
// Time arguments (`at`) accept:
//   2.5      absolute seconds inside the current scope (scene-local)
//   '+0.3'   0.3s after the previous item ends      (default for tweens)
//   '-0.2'   0.2s before the previous item ends (overlap)
//   '<'      same start as the previous item         (default for sfx)
//   '<0.1'   0.1s after the previous item starts
//   '@drop'  named marker (tl.marker('drop', 2.4) / createVideo({ markers })), '@drop+0.2' offset
import { resolveEase, lerp, clamp } from './ease.js';

export const DEFAULTS = {
  x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1,
  rotate: 0, rotateX: 0, rotateY: 0,
  opacity: 1, blur: 0, brightness: 1, clip: 1,
};
const TRANSFORM = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY'];
export const MULTIPLY = new Set(['scale', 'scaleX', 'scaleY', 'opacity', 'clip', 'brightness']);
const isEl = (o) => typeof Element !== 'undefined' && o instanceof Element;

function applyEl(el, v) {
  const st = el.style;
  if (TRANSFORM.some((k) => k in v)) {
    const s = v.scale ?? 1;
    let tr = `translate(${v.x || 0}px, ${v.y || 0}px)`;
    if (v.rotateX || v.rotateY) {
      tr = `perspective(1400px) ${tr} rotateX(${v.rotateX || 0}deg) rotateY(${v.rotateY || 0}deg)`;
    }
    st.transform = `${tr} rotate(${v.rotate || 0}deg) scale(${s * (v.scaleX ?? 1)}, ${s * (v.scaleY ?? 1)})`;
  }
  if ('opacity' in v) st.opacity = clamp(v.opacity);
  if ('blur' in v || 'brightness' in v) {
    st.filter = `blur(${Math.max(0, v.blur ?? 0)}px) brightness(${v.brightness ?? 1})`;
  }
  if ('clip' in v) st.clipPath = `inset(0 ${(1 - clamp(v.clip)) * 100}% 0 0)`;
  for (const k in v) if (k.startsWith('--')) st.setProperty(k, v[k]);
}

export class Timeline {
  constructor() {
    this._root = this;
    this.tracks = new Map(); // target -> Map(prop -> sorted tweens)
    this.mods = new Map(); // target -> [fn(t) => deltas]
    this.renderers = []; // { fn(localT, t), o }
    this.cues = []; // audio cues
    this.captions = []; // { text, s, e }
    this.duration = 0;
    this.ops = []; // applied operators (traceable, serializable)
    this.names = new WeakMap(); // target -> display name
    this._src = null; // current trace label (set by trace()/op())
    this._o = 0;
    this._last = { start: 0, end: 0 };
  }

  // ---- tracing: every tween/modifier/renderer remembers who created it ----
  name(target, n) { this._root.names.set(target, n); return target; }
  nameOf(target) {
    const n = this._root.names.get(target);
    if (n) return n;
    if (isEl(target)) {
      const d = target.dataset || {};
      return d.node || (target.id ? '#' + target.id : '') ||
        target.tagName.toLowerCase() + (target.classList?.length ? '.' + [...target.classList].join('.') : '') + (d.scene ? `[${d.scene}]` : '');
    }
    return target?.name || target?.id || target?.type || 'object';
  }
  // Run fn with a trace label; everything scheduled inside is tagged with it.
  trace(label, fn) {
    const R = this._root, prev = R._src;
    R._src = prev ? `${prev} > ${label}` : label;
    try { return fn(this); } finally { R._src = prev; }
  }
  _label(o) { return o?.label ?? this._root._src ?? null; }

  // A view whose times are offset (used for scenes). Shares all state.
  scope(offset) {
    const s = Object.create(this);
    s._o = offset;
    s._last = { start: 0, end: 0 };
    return s;
  }

  _t(at = '+0') {
    if (typeof at === 'number') return at;
    if (at[0] === '@') {
      const m = at.match(/^@([\w.-]+?)\s*([+-]\s*[\d.]+)?$/), M = this._root.markers || {};
      if (!m || !(m[1] in M)) throw new Error(`timeline: unknown marker "${at}"`);
      return M[m[1]] - this._o + (parseFloat((m[2] || '0').replace(/\s/g, '')) || 0);
    }
    const L = this._last;
    if (at[0] === '<') return L.start + (parseFloat(at.slice(1)) || 0);
    if (at[0] === '+' || at[0] === '-') return L.end + parseFloat(at);
    return parseFloat(at);
  }

  _mark(start, end) {
    this._last = { start, end };
    this._root.duration = Math.max(this._root.duration, this._o + end);
  }

  _track(target) {
    let tm = this.tracks.get(target);
    if (!tm) this.tracks.set(target, (tm = new Map()));
    return tm;
  }

  _tween(target, to, from, o = {}, imm = false) {
    const start = this._t(o.at);
    const dur = o.dur ?? 0.6;
    const e = resolveEase(o.ease);
    const tm = this._track(target);
    for (const k of new Set([...Object.keys(to || {}), ...Object.keys(from || {})])) {
      let arr = tm.get(k);
      if (!arr) {
        tm.set(k, (arr = []));
        arr.base = isEl(target) ? DEFAULTS[k] ?? 0 : target[k] ?? 0;
      }
      arr.push({ s: this._o + start, d: Math.max(dur, 1e-6), e, from: from?.[k], to: to?.[k], imm,
        ease: typeof o.ease === 'string' ? o.ease : o.ease ? 'custom' : 'outCubic', src: this._label(o) });
      arr.sort((a, b) => a.s - b.s);
    }
    this._mark(start, start + dur);
    return this;
  }

  to(target, props, o) { return this._tween(target, props, null, o); }
  // Animates from `props` to the current value; renders `props` before it starts.
  from(target, props, o) { return this._tween(target, null, props, o, true); }
  fromTo(target, fromProps, toProps, o) { return this._tween(target, toProps, fromProps, o, true); }
  set(target, props, o = {}) { return this._tween(target, props, null, { ...o, dur: 0, ease: 'linear' }); }

  // Named time marker (Motion Canvas-style time event). Stored in global time; referenced as at: '@name'.
  marker(name, at = '+0') {
    (this._root.markers ||= {})[name] = this._o + this._t(at);
    return this;
  }

  // Drive an external animation engine frame-exactly (HyperFrames-style): the timeline owns the clock.
  //   tl.drive(el)             every CSS @keyframes / el.animate() animation inside el (Web Animations API)
  //   tl.drive(gsapTimeline)   anything with seek(t) (GSAP, anime.js ...)
  //   tl.drive(lottieAnim)     anything with goToAndStop(ms)
  //   tl.drive(animation)      a single WAAPI Animation
  // o: { at, speed, dur }. Traced as 'drive:<kind>'.
  drive(anim, o = {}) {
    const speed = o.speed ?? 1, s = this._t(o.at ?? 0), T = (lt) => Math.max(0, lt) * speed;
    let kind, step;
    if (isEl(anim)) {
      kind = 'waapi';
      step = (lt) => { for (const a of anim.getAnimations({ subtree: true })) { a.pause(); a.currentTime = T(lt) * 1000; } };
    } else if (typeof anim?.seek === 'function') {
      kind = 'gsap'; anim.pause?.();
      step = (lt) => anim.seek(T(lt), false);
    } else if (typeof anim?.goToAndStop === 'function') {
      kind = 'lottie';
      step = (lt) => anim.goToAndStop(T(lt) * 1000, false);
    } else if (anim && typeof anim.pause === 'function' && 'currentTime' in anim) {
      kind = 'waapi'; anim.pause();
      step = (lt) => { anim.currentTime = T(lt) * 1000; };
    } else throw new Error('timeline.drive: unsupported animation (need an Element, seek(), goToAndStop() or a WAAPI Animation)');
    const own = typeof anim.totalDuration === 'function' ? anim.totalDuration() : undefined;
    const dur = o.dur ?? (Number.isFinite(own) ? own / speed : undefined);
    const R = this._root, label = o.label ?? (R._src ? `${R._src} > drive:${kind}` : `drive:${kind}`);
    return this.add(step, { at: s, dur, label });
  }

  // Advance the relative cursor without adding anything.
  wait(sec) {
    const end = this._last.end;
    this._mark(end, end + sec);
    return this;
  }

  // Per-frame deltas: x/y/rotate add, scale/opacity multiply.
  // o.mode = 'set' makes returned values override instead (used by graph nodes).
  modify(target, fn, o = {}) {
    const g0 = this._o + this._t(o.at ?? 0);
    const dur = o.dur ?? Infinity;
    this._track(target);
    let arr = this.mods.get(target);
    if (!arr) this.mods.set(target, (arr = []));
    const m = (t, v) => (t >= g0 && t <= g0 + dur ? fn(t - g0, t, v) : null);
    Object.assign(m, { s: g0, d: dur, mode: o.mode || 'add', src: this._label(o) });
    arr.push(m);
    return this;
  }

  // Custom per-frame renderer (canvas, puppets, text effects...). Must be a
  // pure function of time. Called every frame with (localT, globalT).
  add(fn, o = {}) {
    const s = this._t(o.at ?? 0);
    this.renderers.push({ fn, o: this._o + s, src: this._label(o) });
    if (o.dur) this._mark(s, s + o.dur);
    return this;
  }

  sfx(name, at = '<', opts = {}) {
    this.cues.push({ type: 'sfx', name, t: this._o + this._t(at), opts, src: this._label() });
    return this;
  }

  // Audio file (music, narration). opts: volume, fadeIn, fadeOut, dur, offset.
  audio(src, at = 0, opts = {}) {
    this.cues.push({ type: 'file', src, t: this._o + this._t(at), opts });
    return this;
  }

  caption(text, at, dur = 3) {
    const s = this._t(at);
    this.captions.push({ text, s: this._o + s, e: this._o + s + dur });
    this._mark(s, s + dur);
    return this;
  }

  // Pure evaluation of every animated prop of a target at time t (no side effects on the target).
  evaluate(target, t) {
    const v = {};
    const tm = this.tracks.get(target);
    if (tm) for (const [k, arr] of tm) v[k] = valueAt(arr, t);
    const mods = this.mods.get(target);
    if (mods) {
      for (const fn of mods) {
        const m = fn(t, v);
        if (!m) continue;
        for (const k in m) {
          if (fn.mode === 'set' || typeof m[k] !== 'number') { v[k] = m[k]; continue; }
          const base = v[k] ?? DEFAULTS[k] ?? 0;
          v[k] = MULTIPLY.has(k) ? base * m[k] : base + m[k];
        }
      }
    }
    return v;
  }
  valueAt(target, prop, t) { return this.evaluate(target, t)[prop]; }
  // Sample a prop as a curve: [[t, v], ...] (for inspectors, graphs, tests).
  sample(target, prop, t0 = 0, t1 = this._root.duration, n = 120) {
    const out = [];
    for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; out.push([t, this.valueAt(target, prop, t)]); }
    return out;
  }

  seek(t) {
    this.time = t;
    for (const target of this.tracks.keys()) {
      const v = this.evaluate(target, t);
      if (isEl(target)) applyEl(target, v);
      else Object.assign(target, v);
    }
    for (const r of this.renderers) r.fn(t - r.o, t);
  }

  // Everything that moves, where it comes from, when. JSON-safe.
  inspect() {
    const R = this._root, fin = (x) => (Number.isFinite(x) ? +x.toFixed(4) : x === Infinity ? 'inf' : x);
    const val = (x) => (typeof x === 'number' ? fin(x) : x ?? null);
    const targets = [];
    for (const [target, tm] of R.tracks) {
      const props = {};
      for (const [k, arr] of tm) {
        props[k] = arr.map((tw) => ({ s: fin(tw.s), e: fin(tw.s + tw.d), from: val(tw.from), to: val(tw.to), ease: tw.ease, src: tw.src }));
      }
      const mods = (R.mods.get(target) || []).map((m) => ({ s: fin(m.s), e: fin(m.s + m.d), mode: m.mode, src: m.src }));
      targets.push({ target: R.nameOf(target), props, mods });
    }
    return {
      duration: fin(R.duration),
      chapters: R.chapters || [],
      markers: Object.fromEntries(Object.entries(R.markers || {}).map(([k, v]) => [k, fin(v)])),
      targets,
      renderers: R.renderers.map((r) => ({ at: fin(r.o), src: r.src })),
      cues: R.cues.map((c) => ({ t: fin(c.t), type: c.type, name: c.name || c.src, src: c.src && c.type === 'file' ? null : c.src || null })),
      captions: R.captions.map((c) => ({ ...c, s: fin(c.s), e: fin(c.e) })),
      ops: R.ops,
      graphs: (R.graphs || []).map((g) => g.toJSON()),
    };
  }
  toJSON() { return this.inspect(); }
}

function valueAt(arr, t) {
  let v = arr.base;
  const first = arr[0];
  if (t < first.s) return first.imm && first.from !== undefined ? first.from : v;
  for (const tw of arr) {
    if (t < tw.s) break;
    const a = tw.from ?? v;
    const b = tw.to ?? v;
    v = lerp(a, b, tw.e(clamp((t - tw.s) / tw.d)));
  }
  return v;
}
