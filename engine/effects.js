// Reusable motion presets. Each takes a timeline scope `tl` plus elements and
// schedules tweens/renderers on it. All are seekable (pure functions of time).
import { noise, rng, clamp, lerp, resolveEase } from './ease.js';

const $ = (q, root = document) => (typeof q === 'string' ? root.querySelector(q) : q);
const $$ = (q, root = document) =>
  typeof q === 'string' ? [...root.querySelectorAll(q)] : Array.isArray(q) ? q : q instanceof NodeList ? [...q] : [q];

// Split text into spans (by 'char' | 'word'). CJK is split per character in both modes.
export function splitText(el, by = 'char') {
  el = $(el);
  if (el._split) return el._split;
  const text = el.textContent;
  el.textContent = '';
  const parts = by === 'word' ? text.split(/(\s+|(?<=[　-鿿＀-￯]))/).filter(Boolean) : [...text];
  const spans = [];
  for (const p of parts) {
    if (/^\s+$/.test(p)) { el.appendChild(document.createTextNode(p)); continue; }
    const s = document.createElement('span');
    s.className = 'split';
    s.textContent = p;
    el.appendChild(s);
    spans.push(s);
  }
  // background-clip:text doesn't reach inline-block children: give each span a slice of the parent gradient.
  const cs = getComputedStyle(el);
  if (/text/.test(cs.webkitBackgroundClip || cs.backgroundClip) && cs.backgroundImage !== 'none') {
    const W = el.offsetWidth, H = el.offsetHeight, r = el.getBoundingClientRect(), k = W / (r.width || 1);
    for (const s of spans) { const q = s.getBoundingClientRect(); Object.assign(s.style, {
      backgroundImage: cs.backgroundImage, backgroundSize: W + 'px ' + H + 'px',
      backgroundPosition: (r.left - q.left) * k + 'px ' + (r.top - q.top) * k + 'px',
      webkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
    }); }
  }
  return (el._split = spans);
}

// Presets: 'rise' | 'drop' | 'blur' | 'pop' | 'flip' | 'wave'
export function textIn(tl, el, { at = '+0', by = 'char', stagger = 0.035, dur = 0.6, preset = 'rise', sfx } = {}) {
  const spans = splitText(el, by);
  const P = {
    rise: [{ y: 40, opacity: 0 }, 'outBack'],
    drop: [{ y: -50, opacity: 0, rotate: -8 }, 'outBounce'],
    blur: [{ blur: 14, opacity: 0, scale: 1.3 }, 'outCubic'],
    pop: [{ scale: 0, opacity: 0 }, 'outBack'],
    flip: [{ rotateX: -90, opacity: 0, y: 20 }, 'outCubic'],
    wave: [{ y: 30, opacity: 0, scale: 0.6 }, 'outElastic'],
  }[preset];
  const t0 = tl._t(at);
  spans.forEach((s, i) => tl.from(s, P[0], { at: t0 + i * stagger, dur, ease: P[1] }));
  if (sfx) tl.sfx(sfx, t0);
  tl._mark(t0, t0 + (spans.length - 1) * stagger + dur);
  return tl;
}

// Typewriter with caret and optional per-key sfx (every `sfxEvery` chars).
export function typewriter(tl, el, { at = '+0', cps = 22, sfx = 'type', sfxEvery = 2, caret = true } = {}) {
  el = $(el);
  const full = el.dataset.text ?? el.textContent;
  el.dataset.text = full;
  const chars = [...full];
  const t0 = tl._t(at), dur = chars.length / cps;
  el.textContent = '';
  tl.add((lt) => {
    const n = clamp(Math.floor(lt * cps), 0, chars.length);
    const blink = lt > dur ? Math.floor(lt * 2) % 2 === 0 : true;
    el.textContent = chars.slice(0, lt < 0 ? 0 : n).join('');
    el.classList.toggle('caret', caret && lt >= 0 && blink);
  }, { at: t0 });
  if (sfx) for (let i = 0; i < chars.length; i += sfxEvery) {
    if (chars[i].trim()) tl.sfx(sfx, t0 + i / cps, { seed: i });
  }
  tl._mark(t0, t0 + dur);
  return tl;
}

// Animated number. format: (n) => string
export function counter(tl, el, { from = 0, to = 100, at = '+0', dur = 1.5, ease = 'outExpo', decimals = 0, format, sfx = 'tick', ticks = 12 } = {}) {
  el = $(el);
  const e = resolveEase(ease), t0 = tl._t(at);
  const fmt = format || ((n) => n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  tl.add((lt) => { el.textContent = fmt(lerp(from, to, e(clamp(lt / dur)))); }, { at: t0 });
  if (sfx) for (let i = 0; i < ticks; i++) tl.sfx(sfx, t0 + dur * (1 - (1 - i / ticks) ** 2) * 0.8, { volume: 0.6 });
  tl._mark(t0, t0 + dur);
  return tl;
}

// Stagger elements in. from: preset props.
export function staggerIn(tl, els, { at = '+0', stagger = 0.08, dur = 0.6, from = { y: 30, opacity: 0 }, ease = 'outCubic', sfx } = {}) {
  const list = $$(els), t0 = tl._t(at);
  list.forEach((el, i) => {
    tl.from(el, from, { at: t0 + i * stagger, dur, ease });
    if (sfx) tl.sfx(sfx, t0 + i * stagger);
  });
  tl._mark(t0, t0 + (list.length - 1) * stagger + dur);
  return tl;
}

// Slow pan/zoom on an image (documentary style).
export function kenBurns(tl, el, { at = 0, dur = 8, fromScale = 1.08, toScale = 1.22, x = [-20, 20], y = [10, -10] } = {}) {
  return tl.fromTo($(el), { scale: fromScale, x: x[0], y: y[0] }, { scale: toScale, x: x[1], y: y[1] }, { at, dur, ease: 'linear' });
}

// Gentle idle float (additive, never ends).
export function float(tl, el, { amp = 10, speed = 0.4, rot = 1.5, seed = 1 } = {}) {
  return tl.modify($(el), (lt) => ({ y: noise(lt * speed, seed) * amp, x: noise(lt * speed * 0.7, seed + 3) * amp * 0.5, rotate: noise(lt * speed * 0.5, seed + 7) * rot }));
}

// Screen shake (additive).
export function shake(tl, el, { at = '<', dur = 0.4, amp = 14 } = {}) {
  const t0 = tl._t(at);
  return tl.modify($(el), (lt) => {
    const k = 1 - lt / dur;
    return { x: noise(lt * 40, 1) * amp * k, y: noise(lt * 40, 2) * amp * k };
  }, { at: t0, dur });
}

// Parallax: layers move by depth when "camera" pans. layers: [[el, depth]]
export function parallax(tl, layers, { at = 0, dur = 6, dx = -120, dy = 0, ease = 'inOutQuad' } = {}) {
  layers.forEach(([el, d]) => tl.to($(el), { x: dx * d, y: dy * d }, { at, dur, ease }));
  return tl;
}

// Fake cursor that moves to targets and clicks. steps: [{ to: el|[x,y], at, dur, click }]
export function cursor(tl, stage, steps) {
  const c = document.createElement('div');
  c.className = 'fx-cursor';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M3 2l7 19 2.6-7.8L20 11z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg><i></i>';
  $(stage).appendChild(c);
  const ring = c.querySelector('i');
  const pos = (to) => {
    if (Array.isArray(to)) return to;
    const r = $(to).getBoundingClientRect(), s = $(stage).getBoundingClientRect();
    const k = s.width / $(stage).offsetWidth;
    return [(r.left - s.left + r.width / 2) / k, (r.top - s.top + r.height / 2) / k];
  };
  let first = true;
  for (const st of steps) {
    const at = tl._t(st.at ?? '+0.2');
    // Scenes are built after mounting (all laid out, untransformed), so
    // positions can be measured now.
    const [px, py] = pos(st.to);
    const moveDur = st.dur ?? 0.7;
    if (first) {
      tl.fromTo(c, { opacity: 0, x: px + 200, y: py + 160 }, { opacity: 1 }, { at: 0, dur: 0.001 });
      tl.to(c, { opacity: 1 }, { at, dur: 0.001 });
      first = false;
    }
    tl.to(c, { x: px, y: py }, { at, dur: moveDur, ease: 'inOutCubic' });
    if (st.click) {
      const ct = at + moveDur;
      tl.to(c, { scale: 0.85 }, { at: ct, dur: 0.08 }).to(c, { scale: 1 }, { at: ct + 0.08, dur: 0.15 });
      tl.fromTo(ring, { scale: 0.2, opacity: 0.9 }, { scale: 2.2, opacity: 0 }, { at: ct, dur: 0.5, ease: 'outCubic' });
      tl.sfx('click', ct);
      if (st.press) tl.to($(st.to), { scale: 0.95 }, { at: ct, dur: 0.08 }).to($(st.to), { scale: 1 }, { at: ct + 0.08, dur: 0.2, ease: 'outBack' });
    }
    tl._mark(at, at + moveDur + (st.click ? 0.3 : 0));
  }
  return c;
}

// Spotlight / highlight box around an element.
export function highlight(tl, stage, target, { at = '+0', dur = 1.6, pad = 12, color = 'var(--accent)' } = {}) {
  const box = document.createElement('div');
  box.className = 'fx-highlight';
  box.style.setProperty('--c', color);
  $(stage).appendChild(box);
  const t0 = tl._t(at);
  const r = $(target).getBoundingClientRect(), s = $(stage).getBoundingClientRect();
  const k = s.width / $(stage).offsetWidth;
  Object.assign(box.style, {
    left: (r.left - s.left) / k - pad + 'px', top: (r.top - s.top) / k - pad + 'px',
    width: r.width / k + pad * 2 + 'px', height: r.height / k + pad * 2 + 'px',
  });
  tl.fromTo(box, { opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1 }, { at: t0, dur: 0.35, ease: 'outBack' });
  tl.to(box, { opacity: 0 }, { at: t0 + dur, dur: 0.3 });
  tl.sfx('pop', t0, { volume: 0.6 });
  tl._mark(t0, t0 + dur + 0.3);
  return box;
}

// SVG path draw-on. el: <path> or <svg> (all paths).
export function drawPath(tl, el, { at = '+0', dur = 1.2, stagger = 0.1, ease = 'inOutCubic' } = {}) {
  const paths = $(el).tagName === 'path' ? [$(el)] : [...$(el).querySelectorAll('path,line,polyline,circle,rect')];
  const t0 = tl._t(at), e = resolveEase(ease);
  paths.forEach((p, i) => {
    const len = p.getTotalLength?.() ?? 1000;
    p.style.strokeDasharray = len;
    tl.add((lt) => { p.style.strokeDashoffset = len * (1 - e(clamp(lt / dur))); }, { at: t0 + i * stagger });
  });
  tl._mark(t0, t0 + (paths.length - 1) * stagger + dur);
  return tl;
}

// Canvas particle field. mode: 'dust' | 'burst' | 'confetti' | 'stars' | 'bokeh'
export function particles(tl, stage, { mode = 'dust', at = 0, count = 80, color = '#ffffff', colors, seed = 3, origin = [0.5, 0.5], dur = Infinity, z = 1, sfx } = {}) {
  const st = $(stage);
  const W = st.offsetWidth || 1920, H = st.offsetHeight || 1080;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'fx-particles';
  cv.style.zIndex = z;
  st.appendChild(cv);
  const g = cv.getContext('2d');
  const r = rng(seed);
  const pal = colors || [color];
  const ps = Array.from({ length: count }, () => ({
    x: r(), y: r(), s: r(), a: r() * Math.PI * 2, v: 0.3 + r() * 0.7, c: pal[Math.floor(r() * pal.length)], ph: r() * 10,
  }));
  const t0 = tl._t(at);
  tl.add((lt) => {
    g.clearRect(0, 0, W, H);
    if (lt < 0 || lt > dur) return;
    for (const p of ps) {
      let x, y, size, alpha = 1, rot = 0;
      if (mode === 'burst' || mode === 'confetti') {
        const sp = p.v * (mode === 'burst' ? 900 : 1300);
        const k = 1 - Math.exp(-lt * 3);
        x = origin[0] * W + Math.cos(p.a) * sp * k / 3;
        y = origin[1] * H + Math.sin(p.a) * sp * k / 3 - (mode === 'confetti' ? 500 * k * p.v : 0) + lt * lt * (mode === 'confetti' ? 380 : 120);
        size = mode === 'confetti' ? 8 + p.s * 10 : 2 + p.s * 5;
        alpha = clamp(1.6 - lt * 0.8);
        rot = lt * 8 * (p.s - 0.5);
      } else {
        const sp = mode === 'stars' ? 0.004 : 0.012;
        x = ((p.x + noise(lt * 0.1 + p.ph, 1) * 0.03 + lt * sp * p.v) % 1) * W;
        y = ((p.y + noise(lt * 0.1 + p.ph, 2) * 0.03 - lt * sp * 0.6 * p.v + 10) % 1) * H;
        size = mode === 'bokeh' ? 20 + p.s * 60 : mode === 'stars' ? 0.8 + p.s * 2 : 1 + p.s * 3;
        alpha = mode === 'stars' ? 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(lt * 3 + p.ph * 5)) : mode === 'bokeh' ? 0.08 + p.s * 0.12 : 0.25 + p.s * 0.5;
      }
      g.globalAlpha = alpha * clamp(lt * 2);
      g.fillStyle = p.c;
      if (mode === 'confetti') {
        g.save(); g.translate(x, y); g.rotate(rot + p.a);
        g.fillRect(-size / 2, -size / 4, size, size / 2 * Math.abs(Math.cos(lt * 6 + p.ph)));
        g.restore();
      } else {
        g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
      }
    }
    g.globalAlpha = 1;
  }, { at: t0 });
  const psfx = sfx !== undefined ? sfx : mode === 'confetti' ? 'success' : 'sparkle';
  if (psfx && (mode === 'burst' || mode === 'confetti')) tl.sfx(psfx, t0);
  return cv;
}

// Decode/scramble text: random glyphs resolve left→right into the final text.
export function scramble(tl, el, { at = '+0', dur = 1, glyphs = '█▓▒░<>/\|=+*#01ABCDEFXYZ', seed = 5, sfx = 'blip', fps = 30 } = {}) {
  el = $(el);
  const full = el.dataset.text ?? el.textContent;
  el.dataset.text = full;
  const chars = [...full], t0 = tl._t(at);
  tl.add((lt) => {
    if (lt < 0) { el.textContent = ''; return; }
    const p = lt / dur, f = Math.floor(lt * fps);
    if (p >= 1) { if (el.textContent !== full) el.textContent = full; return; }
    const r = rng(seed + f);
    el.textContent = chars.map((c, i) => (c === ' ' ? ' ' : i / chars.length < p * 1.4 - 0.4 ? c : i / chars.length < p * 1.4 ? glyphs[Math.floor(r() * glyphs.length)] : '')).join('');
  }, { at: t0 });
  if (sfx) for (let i = 0; i < 5; i++) tl.sfx(sfx, t0 + (i * dur) / 5, { freq: 900 + i * 180, volume: 0.6 });
  tl._mark(t0, t0 + dur);
  return tl;
}

// RGB-split glitch bursts on an element (text-shadow + jitter), deterministic.
export function glitch(tl, el, { at = '+0', dur = 0.5, amp = 12, colors = ['#ff2e88', '#c6ff00'], seed = 9 } = {}) {
  el = $(el);
  const t0 = tl._t(at);
  tl.add((lt) => {
    if (lt < 0 || lt > dur) { if (el.style.textShadow) el.style.textShadow = ''; return; }
    const r = rng(seed + Math.floor(lt * 30)), k = amp * (1 - lt / dur);
    const dx = (r() - 0.5) * k * 2, dy = (r() - 0.5) * k * 0.4;
    el.style.textShadow = `${dx}px ${dy}px 0 ${colors[0]}, ${-dx}px ${-dy}px 0 ${colors[1]}`;
  }, { at: t0 });
  tl.modify(el, (lt) => { const r = rng(seed * 3 + Math.floor(lt * 30)); return { x: r() < 0.35 ? (r() - 0.5) * amp * 2 : 0 }; }, { at: t0, dur });
  tl._mark(t0, t0 + dur);
  return tl;
}

// Seekable image-sequence layer (e.g. TouchDesigner Movie File Out → PNG sequence).
// src: (i) => url, or pattern with #### (zero-padded frame index). Returns { el, ready }.
export function sequence(tl, stage, { src, count, fps = 30, at = 0, loop = true, start = 0, z = 0, fit = 'cover', blend } = {}) {
  const pad = (i) => (typeof src === 'function' ? src(i) : src.replace(/#+/, (m) => String(i).padStart(m.length, '0')));
  const cv = document.createElement('canvas');
  const st = $(stage);
  cv.width = st.offsetWidth || 1920; cv.height = st.offsetHeight || 1080;
  Object.assign(cv.style, { position: 'absolute', inset: 0, zIndex: z, pointerEvents: 'none', mixBlendMode: blend || 'normal' });
  st.appendChild(cv);
  const g = cv.getContext('2d');
  const imgs = Array.from({ length: count }, (_, i) => Object.assign(new Image(), { src: pad(start + i) }));
  const ready = Promise.all(imgs.map((im) => im.decode().catch(() => {})));
  const t0 = tl._t(at);
  tl.add((lt) => {
    const k = lt - t0;
    g.clearRect(0, 0, cv.width, cv.height);
    if (k < 0) return;
    let f = Math.floor(k * fps);
    f = loop ? f % count : Math.min(f, count - 1);
    const im = imgs[f];
    if (!im.naturalWidth) return;
    const s = (fit === 'contain' ? Math.min : Math.max)(cv.width / im.naturalWidth, cv.height / im.naturalHeight);
    const w = im.naturalWidth * s, h = im.naturalHeight * s;
    g.drawImage(im, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
  });
  return { el: cv, ready };
}
