// Live2D-style puppets built from GPT-image output, no Cubism runtime needed.
//
// Two modes, both pure functions of time (seekable/exportable):
//
// 1. Mesh puppet: one transparent PNG character, deformed on a triangle mesh
//    (breathing, body sway, head tilt, hair lag, squash on "bounce").
//      new MeshPuppet({ src, width, height, headLine: 0.35, ... })
//
// 2. Layered puppet: separate transparent parts (body, head, hair, eyes,
//    eyes-closed, mouth-open...) composited with pivots and parallax.
//    Agents produce parts by generating a base character, then using the edits
//    endpoint to isolate / vary each part (see tools/gen-image.mjs --edit).
//      new LayeredPuppet({ width, height, parts: [...] })
//
// Common API:  puppet.el (append to a scene), puppet.update(t),
//              puppet.talk(start, end), puppet.look(x, y, at, dur), puppet.emote(name, at)
import { noise, clamp, smoothstep, lerp } from './ease.js';

const loadImg = (src) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => rej(new Error(`image failed: ${src}`));
  i.src = src;
});

class PuppetBase {
  constructor(o) {
    this.o = { breath: 1, sway: 1, blinkEvery: 3.2, seed: 7, ...o };
    this.talks = [];
    this.looks = [];
    this.emotes = [];
    // Manipulable channels, added to the procedural pose every frame (tween / graph-drive them).
    this.params = { breath: 0, sway: 0, headX: 0, headY: 0, tilt: 0, nod: 0, shake: 0, bounce: 0, mouth: 0, blink: 0 };
  }
  talk(s, e) { this.talks.push([s, e]); return this; }
  look(x, y, at, dur = 0.5) { this.looks.push({ x, y, at, dur }); this.looks.sort((a, b) => a.at - b.at); return this; }
  // 'nod' | 'shake' | 'bounce' | 'tilt'
  emote(name, at, dur = 0.8) { this.emotes.push({ name, at, dur }); return this; }

  // Shared motion model. Everything in "normalized" units.
  pose(t) {
    const { breath, sway, seed, blinkEvery } = this.o;
    const p = {
      breath: Math.sin(t * 2 * Math.PI / 3.6) * 0.5 + 0.5,
      sway: noise(t * 0.35, seed) * sway,
      headX: noise(t * 0.5, seed + 1) * 0.6,
      headY: noise(t * 0.4, seed + 2) * 0.4,
      tilt: noise(t * 0.3, seed + 3) * 3 * sway,
      bounce: 0, nod: 0, shake: 0,
      mouth: 0, blink: 0,
    };
    p.breath *= breath;
    // gaze
    let lx = 0, ly = 0;
    for (const l of this.looks) {
      if (t < l.at) break;
      const k = smoothstep(0, 1, (t - l.at) / l.dur);
      lx = lerp(lx, l.x, k); ly = lerp(ly, l.y, k);
    }
    p.headX += lx; p.headY += ly; p.lookX = lx; p.lookY = ly;
    // blink: deterministic intervals with jitter
    const period = blinkEvery;
    const n = Math.floor(t / period);
    const bt = n * period + (noise(n * 1.7, seed + 9) * 0.5 + 0.5) * period * 0.6;
    const d = t - bt;
    if (d >= 0 && d < 0.16) p.blink = Math.sin((d / 0.16) * Math.PI);
    // talking: syllable-like open/close
    for (const [s, e] of this.talks) {
      if (t >= s && t <= e) {
        const env = smoothstep(s, s + 0.08, t) * (1 - smoothstep(e - 0.08, e, t));
        p.mouth = clamp((Math.abs(Math.sin(t * 17)) * 0.7 + noise(t * 9, seed + 4) * 0.4 + 0.2) * env);
      }
    }
    for (const em of this.emotes) {
      const k = (t - em.at) / em.dur;
      if (k < 0 || k > 1) continue;
      const w = Math.sin(k * Math.PI);
      if (em.name === 'nod') p.nod += Math.sin(k * Math.PI * 4) * w * 6;
      if (em.name === 'shake') p.shake += Math.sin(k * Math.PI * 6) * w * 8;
      if (em.name === 'bounce') p.bounce += Math.abs(Math.sin(k * Math.PI * 2)) * w;
      if (em.name === 'tilt') p.tilt += w * 10;
    }
    for (const k in this.params) if (typeof this.params[k] === 'number' && k in p) p[k] += this.params[k];
    p.mouth = clamp(p.mouth); p.blink = clamp(p.blink);
    return p;
  }
}

export class MeshPuppet extends PuppetBase {
  // o: src, width, height, cols=12, rows=16, headLine (0..1 from top, where the
  // neck is), anchorY (feet), hairLag
  constructor(o) {
    super({ cols: 12, rows: 16, headLine: 0.38, hairLag: 1, ...o });
    const c = document.createElement('canvas');
    const dpr = o.dpr || 1;
    c.width = o.width * dpr; c.height = o.height * dpr;
    c.style.width = o.width + 'px'; c.style.height = o.height + 'px';
    c.className = 'puppet';
    this.el = c; this.dpr = dpr;
    this.ctx = c.getContext('2d');
    this.ready = loadImg(o.src).then((img) => {
      // Rasterize once: per-triangle draws of an SVG re-render vectors and leave seam lines.
      const k = Math.max(dpr, img.naturalWidth / o.width || 1);
      const bmp = document.createElement('canvas');
      bmp.width = Math.round(o.width * k); bmp.height = Math.round(o.height * k);
      bmp.getContext('2d').drawImage(img, 0, 0, bmp.width, bmp.height);
      this.img = bmp;
    });
  }

  deform(u, v, p) {
    // u,v in 0..1 over image. Returns displaced pixel coordinates.
    const { width: W, height: H, headLine, hairLag } = this.o;
    let x = u * W, y = v * H;
    const fromFeet = 1 - v; // 0 at bottom
    // breathing: chest expands vertically + slightly horizontally
    const chest = Math.exp(-(((v - (headLine + 0.18)) / 0.18) ** 2));
    y -= p.breath * chest * H * 0.008 + p.breath * fromFeet * H * 0.006;
    x += (u - 0.5) * chest * p.breath * W * 0.012;
    // body sway bends proportionally to height^2
    x += p.sway * fromFeet * fromFeet * W * 0.025;
    // bounce: squash then stretch
    y += p.bounce * fromFeet * H * -0.04;
    // head region: rotate around neck pivot
    const head = 1 - smoothstep(headLine - 0.05, headLine + 0.05, v);
    if (head > 0) {
      const ang = ((p.tilt + p.shake * 0.4) * Math.PI / 180) * head;
      const px = W * 0.5, py = headLine * H;
      const dx = x - px, dy = y - py;
      x = px + dx * Math.cos(ang) - dy * Math.sin(ang);
      y = py + dx * Math.sin(ang) + dy * Math.cos(ang);
      x += (p.headX * 0.012 * W + p.shake * 0.002 * W) * head;
      y += (p.headY * 0.01 * H + p.nod * 0.0025 * H) * head;
      // hair/top lags behind (secondary motion)
      const top = 1 - smoothstep(0, headLine, v);
      x += noise(this._t * 0.8 - 0.4, this.o.seed + 5) * top * W * 0.01 * hairLag;
    }
    return [x, y];
  }

  update(t) {
    if (!this.img) return;
    this._t = t;
    const p = this.pose(t);
    const { width: W, height: H, cols, rows } = this.o;
    const g = this.ctx, img = this.img;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const sx = img.width / W, sy = img.height / H;
    const pts = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) pts.push(this.deform(i / cols, j / rows, p));
    }
    const at = (i, j) => pts[j * (cols + 1) + i];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const s0 = [(i / cols) * W, (j / rows) * H];
        const s1 = [((i + 1) / cols) * W, (j / rows) * H];
        const s2 = [(i / cols) * W, ((j + 1) / rows) * H];
        const s3 = [((i + 1) / cols) * W, ((j + 1) / rows) * H];
        tri(g, img, sx, sy, s0, s1, s2, at(i, j), at(i + 1, j), at(i, j + 1));
        tri(g, img, sx, sy, s1, s3, s2, at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
    }
  }
}

// Draws the source triangle (s*) mapped onto destination triangle (d*).
// Destination is expanded by ~1.2px to hide seams.
function tri(g, img, sx, sy, s0, s1, s2, d0, d1, d2) {
  const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
  const grow = (d) => {
    const dx = d[0] - cx, dy = d[1] - cy, l = Math.hypot(dx, dy) || 1;
    return [d[0] + (dx / l) * 1.2, d[1] + (dy / l) * 1.2];
  };
  const [e0, e1, e2] = [grow(d0), grow(d1), grow(d2)];
  g.save();
  g.beginPath();
  g.moveTo(e0[0], e0[1]); g.lineTo(e1[0], e1[1]); g.lineTo(e2[0], e2[1]);
  g.closePath();
  g.clip();
  const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2;
  const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const a = ((d1[0] - d0[0]) * (y2 - y0) - (d2[0] - d0[0]) * (y1 - y0)) / den;
  const b = ((d1[1] - d0[1]) * (y2 - y0) - (d2[1] - d0[1]) * (y1 - y0)) / den;
  const c = ((d2[0] - d0[0]) * (x1 - x0) - (d1[0] - d0[0]) * (x2 - x0)) / den;
  const d = ((d2[1] - d0[1]) * (x1 - x0) - (d1[1] - d0[1]) * (x2 - x0)) / den;
  const e = d0[0] - a * x0 - c * y0;
  const f = d0[1] - b * x0 - d * y0;
  g.transform(a, b, c, d, e, f);
  g.drawImage(img, 0, 0, img.width, img.height, 0, 0, img.width / sx, img.height / sy);
  g.restore();
}

// parts: [{ src, role, x, y, w, h, pivot:[px,py] (0..1 of part), depth, z }]
// roles with built-in behaviour: body, head, hair, hairBack, eyes, eyesClosed,
// mouth, mouthOpen, arm. Any role follows `head` if `follow: 'head'`.
export class LayeredPuppet extends PuppetBase {
  constructor(o) {
    super(o);
    const root = document.createElement('div');
    root.className = 'puppet';
    Object.assign(root.style, { position: 'relative', width: o.width + 'px', height: o.height + 'px' });
    this.el = root;
    this.parts = o.parts.map((p, i) => {
      const im = document.createElement('img');
      im.src = p.src;
      im.draggable = false;
      Object.assign(im.style, {
        position: 'absolute', left: p.x + 'px', top: p.y + 'px',
        width: p.w + 'px', height: p.h + 'px', zIndex: p.z ?? i,
        transformOrigin: `${(p.pivot?.[0] ?? 0.5) * 100}% ${(p.pivot?.[1] ?? 1) * 100}%`,
      });
      root.appendChild(im);
      return { ...p, im };
    });
    this.ready = Promise.all(this.parts.map((p) => p.im.decode().catch(() => {})));
  }

  update(t) {
    const p = this.pose(t);
    for (const part of this.parts) {
      const { role, im } = part;
      const depth = part.depth ?? (role === 'body' ? 0.2 : 1);
      const onHead = role !== 'body' && role !== 'arm' || part.follow === 'head';
      let x = 0, y = 0, r = 0, sy = 1, op = 1;
      if (role === 'body') {
        sy = 1 + p.breath * 0.012;
        r = p.sway * 1.2;
        y = -p.bounce * 18;
      }
      if (onHead) {
        x = (p.headX * 6 + p.shake * 0.8) * depth;
        y = (p.headY * 4 + p.nod * 0.8) * depth - p.breath * 3 - p.bounce * 18;
        r = p.tilt + p.sway * 1.2;
      }
      if (role === 'hair' || role === 'hairBack') {
        r += noise(t * 0.8 - 0.3, this.o.seed + 5) * 2.5;
        x += role === 'hairBack' ? -x * 0.3 : 0;
      }
      if (role === 'eyes') { x += p.lookX * 4; y += p.lookY * 3; op = p.blink > 0.5 ? 0 : 1; }
      if (role === 'eyesClosed') op = p.blink > 0.5 ? 1 : 0;
      if (role === 'mouth') op = p.mouth > 0.35 ? 0 : 1;
      if (role === 'mouthOpen') { op = p.mouth > 0.35 ? 1 : 0; sy = 0.7 + p.mouth * 0.4; }
      if (role === 'arm') r = p.sway * 3 + Math.sin(t * 1.3) * 2;
      im.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg) scaleY(${sy})`;
      im.style.opacity = op;
    }
  }
}
