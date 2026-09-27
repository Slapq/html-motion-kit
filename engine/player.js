// Stage + scene sequencing + transitions + playback + controls + export hooks.
//
//   import { createVideo } from '../../engine/index.js';
//   createVideo({ width: 1920, height: 1080, scenes: [ { id, dur, html, build, transition } ] });
//
// Scene: {
//   id: 'intro',
//   dur: 6,                      // seconds (scene-local timeline starts at 0)
//   html: '<h1 class="title">…</h1>',   // or el: HTMLElement
//   className: 'bg-grad',        // extra classes on the scene root
//   transition: 'fade' | { type, dur }  // how this scene enters (overlaps previous)
//   build(tl, el, ctx) { … }     // schedule animations with scene-local times
//   graph: [items]               // or/and: the scene as pure graph data (Rendervid/Creatomate-style JSON)
//   style: 'sketch' | { style, ...params } | [...] | 'none'   // preset renderer; overrides createVideo({ style })
//   markers: { drop: 2.4 }       // scene-local named times → at: '@drop'
//   rhythm: 'anchor' | 'dense' | 'breathing'   // pacing tag, read by tools/audit.mjs
// }
// Carry: elements with the same data-carry="name" in consecutive scenes/chapters fly from one to the
// other across the boundary (engine/carry.js). ctx.cursor(steps) drives one cursor for the whole film.
// {
// }
// Video props (Remotion-style input props): createVideo({ props: { title: '…' } }) are defaults,
// overridden by ?props=<json> or by `render --props file.json`. Available as ctx.props and as
// {{name}} placeholders inside html / graph items.
import { Timeline } from './timeline.js';
import { fillTemplate } from './graph.js';
import { styleScene, styleTransition } from './style.js';
import { scheduleCues, renderOffline, masterBus } from './audio.js';
import { planChapters, cameraAt, mountBackground, mountProgress } from './continuous.js';
import { setupCarry } from './carry.js';

const TRANSITIONS = {
  // Each: (tl, prevEl, nextEl, dur) at scene-local time 0 of next scene.
  cut: () => {},
  fade: (tl, a, b, d) => { tl.fromTo(b, { opacity: 0 }, { opacity: 1 }, { at: 0, dur: d, ease: 'inOutQuad' }); },
  zoom: (tl, a, b, d) => {
    // The outgoing scene only recedes; the incoming one covers it, so there is never an empty mid-frame.
    tl.fromTo(b, { opacity: 0, scale: 1.08, blur: 6 }, { opacity: 1, scale: 1, blur: 0 }, { at: 0, dur: d, ease: 'outCubic' });
    if (a) tl.to(a, { scale: 0.96, brightness: 0.7 }, { at: 0, dur: d, ease: 'inOutQuad' });
  },
  slide: (tl, a, b, d) => {
    tl.fromTo(b, { x: tl._root.width ?? 1920 }, { x: 0 }, { at: 0, dur: d, ease: 'inOutQuart' });
    if (a) tl.to(a, { x: -600, brightness: 0.4 }, { at: 0, dur: d, ease: 'inOutQuart' });
  },
  up: (tl, a, b, d) => {
    tl.fromTo(b, { y: tl._root.height ?? 1080 }, { y: 0 }, { at: 0, dur: d, ease: 'inOutQuart' });
    if (a) tl.to(a, { y: -400, brightness: 0.4 }, { at: 0, dur: d, ease: 'inOutQuart' });
  },
  wipe: (tl, a, b, d) => { tl.fromTo(b, { clip: 0 }, { clip: 1 }, { at: 0, dur: d, ease: 'inOutCubic' }); },
  circle: (tl, a, b, d) => {
    tl.fromTo(b, { '--iris': 0 }, { '--iris': 150 }, { at: 0, dur: d, ease: 'inOutCubic' });
    tl.set(b, { '--iris': 150 }, { at: d + 0.01 });
  },
  flip: (tl, a, b, d) => {
    tl.fromTo(b, { rotateY: 90, opacity: 0 }, { rotateY: 0, opacity: 1 }, { at: d / 2, dur: d / 2, ease: 'outCubic' });
    if (a) tl.to(a, { rotateY: -90, opacity: 0 }, { at: 0, dur: d / 2, ease: 'inCubic' });
  },
  slash: (tl, a, b, d) => {
    const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    tl.add((lt) => {
      if (lt >= d) { if (b.style.clipPath) b.style.clipPath = ''; return; }
      const x = -30 + 160 * e(Math.max(0, lt) / d);
      b.style.clipPath = `polygon(0 0, ${x + 30}% 0, ${x}% 100%, 0 100%)`;
    });
    if (a) tl.to(a, { x: -240, brightness: 0.35 }, { at: 0, dur: d, ease: 'inOutCubic' });
  },
  shutter: (tl, a, b, d, n = 12) => {
    tl.add((lt) => {
      if (lt >= d) { if (b.style.webkitMaskImage) b.style.webkitMaskImage = b.style.maskImage = ''; return; }
      const p = Math.min(1, Math.max(0, lt) / d), w = 100 / n;
      const m = `repeating-linear-gradient(90deg, #000 0 ${w * p}%, transparent ${w * p}% ${w}%)`;
      b.style.webkitMaskImage = b.style.maskImage = m;
    });
    if (a) tl.to(a, { scale: 1.06, brightness: 0.5 }, { at: 0, dur: d, ease: 'inCubic' });
  },
  glitch: (tl, a, b, d) => {
    tl.fromTo(b, { opacity: 0 }, { opacity: 1 }, { at: 0, dur: d, ease: (t) => (t < 0.9 ? (Math.sin(t * 90) > 0 ? t : 0) : 1) });
    tl.modify(b, (lt) => ({ x: Math.sin(lt * 173) * 30 * (1 - lt / d) }), { at: 0, dur: d });
  },
};
const TRANSITION_SFX = { fade: null, cut: null, zoom: 'whoosh', slide: 'swoosh', up: 'swoosh', wipe: 'swoosh', circle: 'whoosh', flip: 'swoosh', glitch: 'glitch', slash: 'swoosh', shutter: 'scan' };
export const registerTransition = (name, fn, sfx) => { TRANSITIONS[name] = fn; if (sfx !== undefined) TRANSITION_SFX[name] = sfx; };

export async function createVideo(cfg) {
  const { width = 1920, height = 1080, fps = 30, scenes, root = document.body, theme, music, captions = true, controls = true, audio } = cfg;
  const qs = new URLSearchParams(location.search);
  const exportMode = qs.has('export');
  const props = { ...(cfg.props || {}), ...(window.__props || {}), ...(qs.has('props') ? JSON.parse(qs.get('props')) : {}) };
  document.documentElement.classList.toggle('export', exportMode);
  if (cfg.look) {
    if (!['light', 'dark'].includes(cfg.look)) throw new Error(`createVideo: unknown look "${cfg.look}" (light | dark)`);
    document.documentElement.classList.toggle('light', cfg.look === 'light');
  }
  if (theme) for (const k in theme) document.documentElement.style.setProperty(`--${k}`, theme[k]);

  const wrap = document.createElement('div');
  wrap.className = 'viewport';
  const stage = document.createElement('div');
  stage.className = 'stage';
  Object.assign(stage.style, { width: width + 'px', height: height + 'px' });
  Object.assign(wrap.style, { width: width + 'px', height: height + 'px' });
  wrap.appendChild(stage);
  root.appendChild(wrap);

  const tl = new Timeline();
  tl.width = width; tl.height = height; tl.props = props;
  tl.markers = { ...(cfg.markers || {}) };
  const cap = document.createElement('div');
  cap.className = 'captions';

  if (cfg.chapters && scenes) throw new Error('createVideo: pass either scenes (cut/transition model) or chapters (continuous model), not both');
  if (!cfg.chapters && !scenes?.length) throw new Error('createVideo: scenes or chapters is required');
  const chapters = cfg.chapters
    ? await buildContinuous(cfg, tl, stage, cap, { width, height, fps, props })
    : await buildScenes(cfg, tl, stage, cap, { width, height, props });
  tl.chapters = chapters;
  const cursor = tl.duration;

  if (music) tl.audio(music.src, 0, { volume: 0.35, fadeIn: 1.5, fadeOut: 2.5, loop: true, dur: cursor, ...music });

  if (captions) {
    tl.add((lt, t) => {
      const c = tl.captions.find((c) => t >= c.s && t < c.e);
      const txt = c ? c.text : '';
      if (cap.textContent !== txt) cap.textContent = txt;
      cap.style.opacity = c ? Math.min(1, (t - c.s) * 6, (c.e - t) * 6) : 0;
    });
  }

  // Wait for images/puppets to be ready before first frame.
  const imgs = [...stage.querySelectorAll('img')].map((im) => im.decode?.().catch(() => {}));
  await Promise.all([...imgs, ...(cfg.ready || [])]);

  const player = new Player(tl, stage, wrap, { width, height, fps, audio });
  player.seek(0);
  if (!exportMode) {
    const fit = () => {
      const k = Math.min(innerWidth / width, (innerHeight - (controls ? 56 : 0)) / height);
      stage.style.transform = `scale(${k})`;
      wrap.style.height = height * k + 'px';
      wrap.style.width = width * k + 'px';
    };
    addEventListener('resize', fit);
    fit();
    if (controls) player.mountControls();
    if (controls && cfg.inspector !== false) import('./inspector.js').then((m) => m.mountInspector(player, stage));
  }
  // Export hooks used by tools/render.mjs
  window.__video = {
    width, height, fps, duration: tl.duration, chapters, props,
    seek: (t) => { player.seek(t); return new Promise((r) => requestAnimationFrame(() => r())); },
    audioWav: async () => {
      const bytes = await renderOffline(tl.cues, tl.duration, 48000, player.o.audio);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    hasAudio: tl.cues.length > 0,
    inspect: () => tl.inspect(),
    timeline: tl,
  };
  window.__videoReady = true;
  return player;
}

async function buildScenes(cfg, tl, stage, cap, { width, height, props }) {
  const { scenes } = cfg;
  // Mount all scenes first so layout-dependent effects can measure.
  const mounted = scenes.map((s, i) => {
    const el = s.el || document.createElement('section');
    el.classList.add('scene', ...(s.className ? s.className.split(' ') : []));
    el.dataset.scene = s.id || `s${i}`;
    if (s.html) el.innerHTML = fillTemplate(s.html, props);
    el.style.zIndex = i + 1;
    stage.appendChild(el);
    return el;
  });
  stage.appendChild(cap);
  if (cfg.fonts !== false) await document.fonts?.ready;
  const carry = setupCarry(tl, stage, { fps: cfg.fps ?? 30, z: scenes.length + 1, carry: cfg.carry });
  stage.insertBefore(carry.layer, cap);
  const units = [];

  // Optional persistent layers shared by every scene (scenes without an opaque background show them).
  if (cfg.background) {
    const color = cfg.backgroundColor || cssRGB(getComputedStyle(document.documentElement).getPropertyValue('--accent'));
    const cv = mountBackground(tl, stage, cfg.background, { width, height, ...(color ? { color } : {}) });
    stage.insertBefore(cv, stage.firstChild);
    Object.assign(cv.style, { position: 'absolute', left: 0, top: 0, zIndex: 0, pointerEvents: 'none' });
  }

  // Sequence scenes.
  const chapters = [];
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i], el = mounted[i];
    const tr = typeof s.transition === 'string' ? { type: s.transition } : s.transition || { type: i ? 'fade' : 'cut' };
    const tdur = i === 0 ? 0 : tr.dur ?? 0.8;
    const start = Math.max(0, cursor - tdur);
    const end = start + s.dur;
    chapters.push({ id: el.dataset.scene, title: s.title || el.dataset.scene, start, end, ...(s.rhythm ? { rhythm: s.rhythm } : {}) });
    units.push({ id: el.dataset.scene, root: el, start, window: tdur });
    const sc = tl.scope(start);
    if (i > 0) {
      const stTr = TRANSITIONS[tr.type] ? null : styleTransition(tr);
      if (!stTr && !TRANSITIONS[tr.type]) throw new Error(`scene ${el.dataset.scene}: unknown transition "${tr.type}"; available: ${Object.keys(TRANSITIONS).join(' ')} (or '<style>-in')`);
      (stTr || TRANSITIONS[tr.type])(sc, mounted[i - 1], el, tdur, tr.n);
      const sfx = tr.sfx ?? (stTr ? 'air' : TRANSITION_SFX[tr.type]);
      if (sfx) sc.sfx(sfx, 0);
    }
    for (const [k, v] of Object.entries(s.markers || {})) sc.marker(k, v);
    // Camera drift (px/s): keeps held frames alive like the continuous camera does. Uses the
    // independent CSS `translate` property so it composes with transition transforms.
    const drift = s.drift ?? cfg.drift ?? (cfg.background ? 10 : 0);
    if (drift) tl.add((lt, t) => { el.style.translate = `${(-(t - start) * drift).toFixed(2)}px 0`; }, { at: 0 });
    const ctx = { stage, width, height, start, end, dur: s.dur, index: i, scene: s, props, cursor: carry.cursor(sc, el) };
    await s.build?.(sc, el, ctx);
    if (s.graph) sc.graph({ root: el, stage: el, refs: { stage: el, ...(s.refs || {}) } }).add(fillTemplate(s.graph, props));
    const sst = s.style !== undefined ? s.style : cfg.style;
    if (sst || el.querySelector('[data-style]')) styleScene(sc, el, sst ? fillTemplate(sst, props) : null);
    sc._mark(0, s.dur);
    const last = i === scenes.length - 1;
    tl.add((lt, t) => {
      el.style.visibility = t >= start - 1e-4 && (t < end || last) ? 'visible' : 'hidden';
    }, { at: 0 });
    cursor = end;
  }
  tl.duration = cursor;
  carry.finish(units);
  if (cfg.progress) {
    const hud = document.createElement('div');
    hud.className = 'hud';
    Object.assign(hud.style, { position: 'absolute', inset: 0, zIndex: scenes.length + 2, pointerEvents: 'none' });
    stage.insertBefore(hud, cap);
    mountProgress(tl, hud, chapters, cursor, cfg.progress);
  }
  return chapters;
}

// Continuous model: chapters side by side on one strip, camera + background + progress never stop.
async function buildContinuous(cfg, tl, stage, cap, { width, height, fps, props }) {
  const plan = planChapters(cfg.chapters, { width, fps, camera: cfg.camera });
  const film = document.createElement('section');
  film.className = 'scene film' + (cfg.className ? ' ' + cfg.className : '');
  film.dataset.scene = 'film';
  film.style.visibility = 'visible';
  stage.appendChild(film);
  const strip = document.createElement('div');
  strip.className = 'strip';
  Object.assign(strip.style, { width: plan.worldWidth + 'px', height: height + 'px' });
  const panels = cfg.chapters.map((c, i) => {
    const el = document.createElement('div');
    el.className = 'panel chapter' + (c.className ? ' ' + c.className : '');
    el.dataset.chapter = plan.chapters[i].id;
    Object.assign(el.style, { left: plan.chapters[i].left + 'px', width: width + 'px', height: height + 'px' });
    if (c.html) el.innerHTML = fillTemplate(c.html, props);
    strip.appendChild(el);
    return el;
  });
  const hud = document.createElement('div');
  hud.className = 'hud';
  if (cfg.hud) hud.innerHTML = fillTemplate(cfg.hud, props);
  film.append(strip, hud);
  stage.appendChild(cap);
  if (cfg.fonts !== false) await document.fonts?.ready;
  const carry = setupCarry(tl, film, { fps, z: 5, carry: cfg.carry });
  film.insertBefore(carry.layer, hud);

  tl.duration = plan.duration;
  const bgSpec = cfg.background === undefined ? 'network' : cfg.background;
  const color = cfg.backgroundColor || cssRGB(getComputedStyle(document.documentElement).getPropertyValue('--accent')) || undefined;
  mountBackground(tl, film, bgSpec, { width, height, ...(color ? { color } : {}) });
  mountProgress(tl, hud, plan.chapters, plan.duration, cfg.progress === undefined ? true : cfg.progress);
  tl.add((lt, t) => { strip.style.transform = `translate3d(${cameraAt(plan.keys, t).toFixed(2)}px,0,0)`; }, { at: 0, label: 'camera' });
  tl.camera = plan.keys;

  const out = [];
  for (let i = 0; i < cfg.chapters.length; i++) {
    const c = cfg.chapters[i], p = plan.chapters[i], el = panels[i];
    const sc = tl.scope(p.start);
    for (const [k, v] of Object.entries(c.markers || {})) sc.marker(k, v);
    const ctx = { stage, film, hud, width, height, start: p.start, end: p.end, dur: p.dur, arrive: p.arrive, index: i, chapter: c, props, cursor: carry.cursor(sc, el) };
    await c.build?.(sc, el, ctx);
    if (c.graph) sc.graph({ root: el, stage: el, refs: { stage: el, ...(c.refs || {}) } }).add(fillTemplate(c.graph, props));
    out.push({ id: p.id, title: p.title, start: p.start, end: p.end, ...(c.rhythm ? { rhythm: c.rhythm } : {}) });
  }
  const root = tl.scope(0);
  await cfg.build?.(root, film, { stage, film, hud, strip, width, height, chapters: plan.chapters, camera: plan.keys, props, cursor: carry.cursor(root, film) });
  carry.finish(panels.map((el, i) => ({ id: plan.chapters[i].id, root: el, start: plan.chapters[i].start, window: i ? plan.move : 0 })));
  const fadeOut = cfg.fadeOut ?? 0.7;
  if (fadeOut > 0) root.to(film, { opacity: 0 }, { at: plan.duration - fadeOut, dur: fadeOut, ease: 'outQuad' });
  tl.duration = plan.duration;
  return out;
}

// '#1a73e8' → '26,115,232'
function cssRGB(v) {
  const m = String(v || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
}

class Player {
  constructor(tl, stage, wrap, o) {
    Object.assign(this, { tl, stage, wrap, o, t: 0, playing: false, ac: null });
    this.loop = this.loop.bind(this);
  }
  seek(t) {
    this.t = Math.max(0, Math.min(t, this.tl.duration));
    this.tl.seek(this.t);
    this.onTime?.(this.t);
  }
  async play() {
    if (this.playing) return;
    if (this.t >= this.tl.duration - 0.01) this.seek(0);
    this.playing = true;
    this.ac = new AudioContext();
    this.master = this.ac.createGain();
    this.master.connect(this.ac.destination);
    const ctxStart = this.ac.currentTime + 0.05;
    this.clock = { ctx: ctxStart, t: this.t };
    scheduleCues(this.ac, masterBus(this.ac, this.master, this.o.audio), this.tl.cues, this.t, ctxStart);
    requestAnimationFrame(this.loop);
    this.onState?.();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.master?.disconnect();
    this.ac?.close();
    this.ac = null;
    this.onState?.();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  loop() {
    if (!this.playing) return;
    const t = this.clock.t + Math.max(0, this.ac.currentTime - this.clock.ctx);
    if (t >= this.tl.duration) { this.seek(this.tl.duration); this.pause(); return; }
    this.seek(t);
    requestAnimationFrame(this.loop);
  }
  mountControls() {
    const bar = document.createElement('div');
    bar.className = 'controls';
    bar.innerHTML = `
      <button class="pp" aria-label="播放/暂停">▶</button>
      <div class="track" role="slider" aria-label="进度" tabindex="0"><div class="fill"></div><div class="marks"></div></div>
      <span class="time">0:00 / 0:00</span>
      <select class="chap" aria-label="跳转章节"></select>`;
    document.body.appendChild(bar);
    const pp = bar.querySelector('.pp'), track = bar.querySelector('.track'), fill = bar.querySelector('.fill');
    const time = bar.querySelector('.time'), chap = bar.querySelector('.chap'), marks = bar.querySelector('.marks');
    const D = this.tl.duration;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    for (const c of this.tl.chapters) {
      chap.add(new Option(c.title, c.start));
      const m = document.createElement('i');
      m.style.left = (c.start / D) * 100 + '%';
      marks.appendChild(m);
    }
    chap.onchange = () => { const p = this.playing; this.pause(); this.seek(+chap.value); if (p) this.play(); };
    this.onTime = (t) => {
      fill.style.width = (t / D) * 100 + '%';
      time.textContent = `${fmt(t)} / ${fmt(D)}`;
      track.setAttribute('aria-valuenow', t.toFixed(1));
    };
    this.onState = () => { pp.textContent = this.playing ? '❚❚' : '▶'; };
    pp.onclick = () => this.toggle();
    const scrub = (e) => {
      const r = track.getBoundingClientRect();
      this.seek(((e.clientX - r.left) / r.width) * D);
    };
    track.onpointerdown = (e) => {
      const was = this.playing; this.pause(); scrub(e);
      track.setPointerCapture(e.pointerId);
      track.onpointermove = scrub;
      track.onpointerup = () => { track.onpointermove = null; if (was) this.play(); };
    };
    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT') return;
      const step = e.shiftKey ? 1 / this.o.fps : 2;
      if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
      if (e.code === 'ArrowRight') { const p = this.playing; this.pause(); this.seek(this.t + step); if (p) this.play(); }
      if (e.code === 'ArrowLeft') { const p = this.playing; this.pause(); this.seek(this.t - step); if (p) this.play(); }
      if (e.code === 'Home') this.seek(0);
    });
    this.onTime(this.t);
  }
}
