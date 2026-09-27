// Continuous mode: one long world strip + a camera that never stops + a persistent background
// + a progress axis. Chapters are placed side by side; the engine computes their `left`, the
// camera keys (speed-limited, see docs/lessons.md §2.2) and the progress ticks.
//
//   createVideo({ chapters: [{ id, title, dur, html, build(tl, el, ctx) }], background: 'network', progress: true })
//
// Chapter k owns [start, start + dur). Its local time 0 is when the camera starts travelling
// towards it, so content scheduled at small `at` values enters while the chapter slides in
// (no empty "arrived, now waiting" frames). ctx.arrive is the local time the camera settles.
import { resolveEase, peakSlope, rng } from './ease.js';

export const CAMERA_DEFAULTS = { ease: 'inOutQuad', maxPx: 80, minMove: 0.9, drift: 10 };

// Duration of a move so that the peak speed stays under maxPx per frame.
export function moveDuration(dist, { fps = 30, ease = CAMERA_DEFAULTS.ease, maxPx = CAMERA_DEFAULTS.maxPx, minMove = CAMERA_DEFAULTS.minMove } = {}) {
  const need = (Math.abs(dist) * peakSlope(ease)) / (maxPx * fps);
  // Round up to 0.1s so the result is never faster than the limit (and reads well in keyframes).
  return +Math.max(minMove, Math.ceil(need * 10 - 1e-3) / 10).toFixed(1);
}

// Pure layout: chapter windows, panel offsets and camera keys ([t, x, ease]).
export function planChapters(chapters, { width = 1920, fps = 30, camera = {} } = {}) {
  const c = { ...CAMERA_DEFAULTS, ...camera };
  resolveEase(c.ease);
  const move = moveDuration(width, { fps, ...c });
  const plan = [];
  const keys = [[0, 0]];
  let t = 0;
  chapters.forEach((ch, i) => {
    if (!(ch.dur > 0)) throw new Error(`chapter ${ch.id || i}: dur must be > 0`);
    const x = -i * width;
    const arrive = i === 0 ? 0 : move;
    if (i > 0 && ch.dur < move + 0.5) throw new Error(`chapter ${ch.id || i}: dur ${ch.dur}s is shorter than the camera move (${move}s) + 0.5s`);
    plan.push({ id: ch.id || `c${i}`, title: ch.title || ch.id || `c${i}`, index: i, start: t, end: t + ch.dur, dur: ch.dur, left: i * width, arrive });
    if (i > 0) keys.push([+(t + move).toFixed(3), x, c.ease]);
    // Hold: keep drifting so no frame is static.
    keys.push([+(t + ch.dur).toFixed(3), x - (ch.dur - arrive) * c.drift, 'linear']);
    t += ch.dur;
  });
  return { chapters: plan, keys, move, duration: t, worldWidth: chapters.length * width };
}

// Camera value at time t from keys (same semantics as graph keys: ease belongs to the arriving key).
export function cameraAt(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i], [t0, v0] = keys[i - 1];
    if (t <= t1) return v0 + (v1 - v0) * resolveEase(e || CAMERA_DEFAULTS.ease)((t - t0) / Math.max(1e-6, t1 - t0));
  }
  return keys[keys.length - 1][1];
}

// ---- persistent background layers --------------------------------------------------------
// Each: (tl, host, { width, height, color, ...opts }) → appends a canvas at z-index 0.
export const BACKGROUNDS = {
  // Drifting dots that link when close + slow vertical guides. Never flashes, never stops.
  network(tl, host, { width, height, color = '26,115,232', count = 46, link = 196, seed = 11, alpha = 1, guides = true }) {
    const cv = mountCanvas(host, width, height, 'bg-network');
    const g = cv.getContext('2d');
    const rnd = rng(seed);
    const N = Array.from({ length: count }, () => ({
      bx: 60 + rnd() * (width - 120), by: 50 + rnd() * (height - 200),
      ax: 40 + rnd() * 74, ay: 26 + rnd() * 58,
      wx: 0.09 + rnd() * 0.2, wy: 0.09 + rnd() * 0.2,
      px: rnd() * 6.283, py: rnd() * 6.283,
    }));
    tl.add((lt, t) => {
      g.clearRect(0, 0, width, height);
      g.lineWidth = 1;
      if (guides) {
        g.strokeStyle = `rgba(${color},${0.05 * alpha})`;
        for (let x = -((t * 9) % 160); x < width; x += 160) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); }
      }
      const P = N.map((n) => [n.bx + Math.sin(t * n.wx + n.px) * n.ax, n.by + Math.cos(t * n.wy + n.py) * n.ay]);
      for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
        const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
        if (d > link) continue;
        g.strokeStyle = `rgba(${color},${(0.3 * alpha * (1 - d / link)).toFixed(3)})`;
        g.beginPath(); g.moveTo(P[i][0], P[i][1]); g.lineTo(P[j][0], P[j][1]); g.stroke();
      }
      g.fillStyle = `rgba(${color},${0.42 * alpha})`;
      for (const [x, y] of P) { g.beginPath(); g.arc(x, y, 2.4, 0, 6.2832); g.fill(); }
    }, { at: 0, label: 'background:network' });
    return cv;
  },
  // Quiet dot grid that scrolls slowly (parallax to the camera).
  grid(tl, host, { width, height, color = '26,115,232', gap = 48, alpha = 1 }) {
    const cv = mountCanvas(host, width, height, 'bg-grid');
    const g = cv.getContext('2d');
    tl.add((lt, t) => {
      g.clearRect(0, 0, width, height);
      g.fillStyle = `rgba(${color},${0.16 * alpha})`;
      const ox = -((t * 12) % gap), oy = -((t * 4) % gap);
      for (let x = ox; x < width; x += gap) for (let y = oy; y < height; y += gap) g.fillRect(x, y, 2, 2);
    }, { at: 0, label: 'background:grid' });
    return cv;
  },
};
export const registerBackground = (name, fn) => { BACKGROUNDS[name] = fn; };

function mountCanvas(host, width, height, cls) {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  cv.className = `bg-layer ${cls}`;
  host.appendChild(cv);
  return cv;
}

export function mountBackground(tl, host, spec, env) {
  if (!spec) return null;
  const o = typeof spec === 'string' ? { type: spec } : spec;
  const fn = BACKGROUNDS[o.type];
  if (!fn) throw new Error(`unknown background "${o.type}"; available: ${Object.keys(BACKGROUNDS).join(' ')}`);
  return fn(tl, host, { ...env, ...o });
}

// ---- progress axis ------------------------------------------------------------------------
export function mountProgress(tl, host, chapters, duration, spec) {
  if (!spec) return null;
  const o = spec === true ? {} : spec;
  const el = document.createElement('div');
  el.className = 'progress-axis';
  const ticks = chapters.map((c, i) => `<span class="pa-tick" style="left:${((c.start / duration) * 100).toFixed(3)}%"><i></i><i class="on"></i>${o.labels === false ? '' : `<b>${String(i + 1).padStart(2, '0')} ${esc(c.title)}</b>`}</span>`).join('');
  el.innerHTML = `<div class="pa-line"><i class="pa-fill"></i><i class="pa-head"></i></div><div class="pa-ticks">${ticks}</div>`;
  host.appendChild(el);
  const fill = el.querySelector('.pa-fill'), head = el.querySelector('.pa-head');
  const on = [...el.querySelectorAll('.pa-tick .on')];
  tl.add((lt, t) => {
    const p = Math.max(0, Math.min(1, t / duration));
    fill.style.transform = `scaleX(${p})`;
    head.style.left = `${p * 100}%`;
    chapters.forEach((c, i) => {
      const k = Math.max(0, Math.min(1, (t - c.start) / 0.45));
      on[i].style.opacity = k;
      on[i].style.transform = `scale(${0.4 + 0.6 * (1 - (1 - k) ** 3)})`;
    });
  }, { at: 0, label: 'progress' });
  tl.from(el, { opacity: 0, y: 14 }, { at: 0.25, dur: 0.7, ease: 'outCubic' });
  return el;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
