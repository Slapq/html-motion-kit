// Carry: something survives every boundary.
//
//   <h2 data-carry="title">…</h2>  in scene/chapter A and again in the next one
//
// Elements with the same data-carry name in consecutive scenes/chapters are relayed in screen
// space: at the boundary both originals hide, a flight box on the carry layer (above the
// scenes, below the HUD) tweens geometry from A's live rect to B's live rect, and the two
// snapshots crossfade during the middle 30% of the flight. When the content is identical the
// crossfade is invisible, so it reads as one element moving.
//
// The flight lasts at least the transition window (scenes: transition.dur, chapters: the camera
// move) and is stretched so its peak speed stays ≤ maxPx per frame (same rule as the camera).
//
// cursor: one tutorial cursor for the whole film (ctx.cursor(steps) in any scene/chapter), so it
// travels across boundaries instead of being re-created per scene.
import { resolveEase, clamp } from './ease.js';
import { moveDuration } from './continuous.js';

export const CARRY_DEFAULTS = { ease: 'inOutCubic', maxPx: 80, fade: [0.35, 0.65] };

// Pure: pair names across consecutive units. units: [{ id, names: [...] }] → [{ name, from, to }]
export function pairCarries(units) {
  units.forEach((u, i) => {
    const seen = new Set();
    for (const n of u.names) {
      if (seen.has(n)) throw new Error(`carry: duplicate data-carry="${n}" in ${u.id || i}`);
      seen.add(n);
    }
  });
  const out = [];
  for (let i = 1; i < units.length; i++) {
    const prev = new Set(units[i - 1].names);
    for (const n of units[i].names) if (prev.has(n)) out.push({ name: n, from: i - 1, to: i });
  }
  return out;
}

// Pure: flight duration — never shorter than the window, never faster than maxPx/frame.
export function flightDuration(dist, window, { fps = 30, ease = CARRY_DEFAULTS.ease, maxPx = CARRY_DEFAULTS.maxPx } = {}) {
  return Math.max(window, dist > 0 ? moveDuration(dist, { fps, ease, maxPx, minMove: 0 }) : 0);
}

// Pure: flight state at progress p ∈ [0,1]. a/b: { x, y, w, h }. Geometry eases; the crossfade
// runs on raw time inside `fade` and keeps the sum of opacities ≥ 1 (no see-through dip).
export function carryFrame(a, b, p, e = resolveEase(CARRY_DEFAULTS.ease), [f0, f1] = CARRY_DEFAULTS.fade) {
  const k = e(clamp(p));
  const L = (u, v) => u + (v - u) * k;
  const q = clamp((p - f0) / Math.max(1e-6, f1 - f0));
  return { box: { x: L(a.x, b.x), y: L(a.y, b.y), w: L(a.w, b.w), h: L(a.h, b.h) }, a: 1 - q * q, b: 1 - (1 - q) ** 2 };
}

// Pure: cursor position/opacity at global time t. path: [{ t0, t1, p: [x,y], ease }] sorted by t0,
// plus optional hides: [t]. The cursor enters from an offset before the first move.
export function cursorAt(path, t, hides = []) {
  if (!path.length || t < path[0].t0) return null;
  let prev = [path[0].p[0] + 200, path[0].p[1] + 160];
  let pos = prev;
  for (const s of path) {
    if (t < s.t0) break;
    const k = resolveEase(s.ease || 'inOutCubic')(clamp((t - s.t0) / Math.max(1e-6, s.t1 - s.t0)));
    pos = [prev[0] + (s.p[0] - prev[0]) * k, prev[1] + (s.p[1] - prev[1]) * k];
    prev = t >= s.t1 ? s.p : pos;
  }
  // Fade in at the first move; fade out after a hide; fade back in when a later move starts.
  const h = hides.filter((x) => x <= t).pop();
  let o = clamp((t - path[0].t0) / 0.25);
  if (h !== undefined && h >= path[0].t0) {
    const back = path.find((s) => s.t0 > h && s.t0 <= t);
    o = back ? clamp((t - back.t0) / 0.25) : 1 - clamp((t - h) / 0.45);
  }
  return { x: pos[0], y: pos[1], o };
}

// ---- DOM -----------------------------------------------------------------------------------
const scaleOf = (host) => host.getBoundingClientRect().width / (host.offsetWidth || 1);
export function rectIn(el, host) {
  const r = el.getBoundingClientRect(), h = host.getBoundingClientRect(), k = scaleOf(host);
  return { x: (r.left - h.left) / k, y: (r.top - h.top) / k, w: r.width / k, h: r.height / k };
}

// Frozen copy with computed styles inlined (scene-scoped CSS does not match on the carry layer).
function snapshot(el) {
  const c = el.cloneNode(true);
  const walk = (s, d) => {
    const cs = getComputedStyle(s);
    let txt = '';
    for (let i = 0; i < cs.length; i++) txt += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
    d.style.cssText = txt;
    d.style.visibility = 'visible';
    d.removeAttribute('id');
    d.removeAttribute('data-carry');
    [...s.children].forEach((ch, i) => d.children[i] && walk(ch, d.children[i]));
  };
  walk(el, c);
  Object.assign(c.style, {
    position: 'absolute', left: '0', top: '0', margin: '0', transform: 'none', translate: 'none',
    transformOrigin: '0 0', opacity: '1', filter: 'none', clipPath: 'none', maskImage: 'none', webkitMaskImage: 'none',
  });
  return c;
}

// items: [{ name, src, dst, s (global), window, from, to }]
export function mountCarries(tl, layer, items, { fps = 30, ease = CARRY_DEFAULTS.ease, maxPx = CARRY_DEFAULTS.maxPx, roots } = {}) {
  const e = resolveEase(ease);
  // el → [test(t)]. The destination is hidden by the same p < 1 test that shows the flight, so the
  // original and the flight box never appear together on the hand-over frame (float edge).
  const hide = new Map();
  const push = (el, fn) => { if (!hide.has(el)) hide.set(el, []); hide.get(el).push(fn); };
  const flights = items.map((it) => {
    // Build-time layout (nothing is transformed yet): distance in screen space between the two ends.
    const a0 = rectIn(it.src, roots[it.from]), b0 = rectIn(it.dst, roots[it.to]);
    const dist = Math.hypot(b0.x + b0.w / 2 - a0.x - a0.w / 2, b0.y + b0.h / 2 - a0.y - a0.h / 2) + Math.abs(b0.w - a0.w);
    const d = flightDuration(dist, it.window, { fps, ease, maxPx });
    const box = document.createElement('div');
    box.className = 'carry-box';
    box.dataset.carryName = it.name;
    const ca = snapshot(it.src), cb = snapshot(it.dst);
    box.append(ca, cb);
    box.style.display = 'none';
    layer.appendChild(box);
    push(it.src, (t) => t >= it.s);
    push(it.dst, (t) => (t - it.s) / d < 1);
    return { ...it, d, box, ca, cb, a0, b0 };
  });
  const place = (c, n, bx, o) => {
    const s = Math.sqrt((bx.w / n.w) * (bx.h / n.h)) || 1;
    c.style.transform = `translate(${(bx.x + (bx.w - n.w * s) / 2).toFixed(2)}px, ${(bx.y + (bx.h - n.h * s) / 2).toFixed(2)}px) scale(${s.toFixed(4)})`;
    c.style.opacity = o.toFixed(3);
  };
  tl.add((lt, t) => {
    for (const [el, ivs] of hide) el.style.visibility = ivs.some((f) => f(t)) ? 'hidden' : '';
    for (const f of flights) {
      const p = (t - f.s) / f.d;
      const on = p >= 0 && p < 1;
      f.box.style.display = on ? '' : 'none';
      if (!on) continue;
      const fr = carryFrame(rectIn(f.src, layer), rectIn(f.dst, layer), p, e);
      place(f.ca, f.a0, fr.box, fr.a);
      place(f.cb, f.b0, fr.box, fr.b);
    }
  }, { at: 0, label: 'carry' });
  return flights.map(({ name, from, to, s, d }) => ({ name, from, to, s, d }));
}
// One cursor for the whole film. Steps from any scene/chapter append to the same path; element
// targets and [x,y] points (in that scene's/chapter's own coordinates) are resolved live every
// frame, so the cursor rides along with the camera and flies across boundaries.
export function filmCursor(tl, layer) {
  const c = document.createElement('div');
  c.className = 'fx-cursor film-cursor';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M3 2l7 19 2.6-7.8L20 11z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg><i></i>';
  c.style.opacity = '0';
  layer.appendChild(c);
  const ring = c.querySelector('i');
  const path = [], hides = [];
  const add = (sc, root, steps) => {
    for (const st of steps) {
      const t0 = sc._o + sc._t(st.at ?? '+0.2');
      if (st.to !== undefined) {
        const dur = st.dur ?? 0.7;
        const to = st.to, fx = st.fx ?? 0.5, fy = st.fy ?? 0.5;
        const p = Array.isArray(to)
          ? () => { const r = rectIn(root, layer), k = root.offsetWidth ? r.w / root.offsetWidth : 1; return [r.x + to[0] * k, r.y + to[1] * k]; }
          : () => { const r = rectIn(to, layer); return [r.x + r.w * fx, r.y + r.h * fy]; };
        path.push({ t0, t1: t0 + dur, p, ease: st.ease });
        if (st.click) {
          const ct = t0 - sc._o + dur;
          sc.to(c, { scale: 0.85 }, { at: ct, dur: 0.08 }).to(c, { scale: 1 }, { at: ct + 0.08, dur: 0.15 });
          sc.fromTo(ring, { scale: 0.2, opacity: 0.9 }, { scale: 2.2, opacity: 0 }, { at: ct, dur: 0.5, ease: 'outCubic' });
          sc.sfx('click', ct);
          if (st.press && !Array.isArray(to)) sc.to(to, { scale: 0.95 }, { at: ct, dur: 0.08 }).to(to, { scale: 1 }, { at: ct + 0.08, dur: 0.2, ease: 'outBack' });
          st.then?.(ct);
        }
        sc._mark(t0 - sc._o, t0 - sc._o + dur + (st.click ? 0.3 : 0));
      }
      if (st.hide !== undefined) hides.push(sc._o + sc._t(st.hide));
    }
    path.sort((a, b) => a.t0 - b.t0);
    hides.sort((a, b) => a - b);
    return c;
  };
  // Registered by setupCarry().finish() so it runs after camera/drift renderers (live rects).
  const render = (t) => {
    const live = path.filter((s, i) => i === 0 || s.t0 <= t).map((s) => ({ ...s, p: s.p() }));
    const v = cursorAt(live, t, hides);
    if (!v) { c.style.opacity = '0'; return; }
    c.style.translate = `${v.x.toFixed(2)}px ${v.y.toFixed(2)}px`;
    c.style.opacity = v.o.toFixed(3);
  };
  return { el: c, add, render, get used() { return path.length > 0; } };
}

// Wire carry + cursor into a build. Call before building units; finish() after all are built
// (its renderers must run after the camera/drift ones so the rects they read are this frame's).
export function setupCarry(tl, host, { fps = 30, z = 5, carry = {} } = {}) {
  const layer = document.createElement('div');
  layer.className = 'carry-layer';
  Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: z, pointerEvents: 'none' });
  host.appendChild(layer);
  let cur = null;
  const cursor = (sc, root) => (steps) => (cur ||= filmCursor(tl, layer)).add(sc, root, steps);
  const finish = (units) => {
    // units: [{ id, root, start, window }] — window = boundary transition length into this unit
    const names = units.map((u) => ({ id: u.id, names: [...u.root.querySelectorAll('[data-carry]')].map((e) => e.dataset.carry) }));
    const pairs = pairCarries(names);
    const items = pairs.map((p) => ({
      ...p,
      src: units[p.from].root.querySelector(`[data-carry="${CSS.escape(p.name)}"]`),
      dst: units[p.to].root.querySelector(`[data-carry="${CSS.escape(p.name)}"]`),
      s: units[p.to].start, window: units[p.to].window,
    }));
    const flights = mountCarries(tl, layer, items, { fps, ...carry, roots: units.map((u) => u.root) });
    if (cur) tl.add((lt, t) => cur.render(t), { at: 0, label: 'cursor' });
    // Coverage: which boundaries hand something over (carry or the film cursor moving across it).
    const boundaries = units.slice(1).map((u, i) => ({
      from: units[i].id, to: u.id, at: u.start,
      carries: flights.filter((f) => f.to === i + 1).map((f) => f.name),
    }));
    tl.carry = { flights, boundaries, cursor: !!cur?.used };
    return tl.carry;
  };
  return { layer, cursor, finish };
}
