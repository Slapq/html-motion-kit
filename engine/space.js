// Space3D: a tiny deterministic 3D renderer on Canvas2D (points, lines, planes).
// No WebGL, no deps — every frame is a pure function of time, so export is exact.
//
//   const sp = new Space3D(el, { fov: 900, fog: [800, 5000] });
//   const route = sp.add(Space3D.polyline(pts, { color: '#c6ff00', width: 3, progress: 0 }));
//   tl.to(route, { progress: 1 }, { at: 0.5, dur: 3 });        // objects are tweenable
//   tl.to(sp.cam, { z: -800, ry: 20 }, { at: 0, dur: 6 });     // so is the camera
//   sp.bind(tl);                                                // render every frame
//
// Object fields (all tweenable): x y z rx ry rz s opacity progress, plus color/width/size.
import { rng, clamp } from './ease.js';

const D = Math.PI / 180;
const rot = (p, rx, ry, rz) => {
  let [x, y, z] = p;
  if (rz) { const c = Math.cos(rz * D), s = Math.sin(rz * D); [x, y] = [x * c - y * s, x * s + y * c]; }
  if (rx) { const c = Math.cos(rx * D), s = Math.sin(rx * D); [y, z] = [y * c - z * s, y * s + z * c]; }
  if (ry) { const c = Math.cos(ry * D), s = Math.sin(ry * D); [x, z] = [x * c + z * s, -x * s + z * c]; }
  return [x, y, z];
};

export class Space3D {
  constructor(parent, { width, height, fov = 900, fog = [600, 6000], near = 20, blend = 'lighter', z = 0 } = {}) {
    const W = width || parent.offsetWidth || 1920, H = height || parent.offsetHeight || 1080;
    this.cv = Object.assign(document.createElement('canvas'), { width: W, height: H, className: 'fx-space' });
    Object.assign(this.cv.style, { position: 'absolute', left: 0, top: 0, zIndex: z, pointerEvents: 'none' });
    parent.appendChild(this.cv);
    this.g = this.cv.getContext('2d');
    Object.assign(this, { W, H, fov, fog, near, blend, objs: [] });
    this.cam = { x: 0, y: 0, z: -1200, rx: 0, ry: 0, rz: 0, fov };
  }
  add(o) { this.objs.push(o); return o; }
  bind(tl, at = 0) { tl.add((lt, t) => this.render(lt, t), { at }); return this; }

  // world -> screen [sx, sy, depth] or null if behind camera
  project(p) {
    const c = this.cam;
    let q = [p[0] - c.x, p[1] - c.y, p[2] - c.z];
    q = rot(q, 0, -c.ry, 0); q = rot(q, -c.rx, 0, 0); q = rot(q, 0, 0, -c.rz);
    if (q[2] < this.near) return null;
    const k = (c.fov || this.fov) / q[2];
    return [this.W / 2 + q[0] * k, this.H / 2 + q[1] * k, q[2], k];
  }
  _world(o, p) {
    const s = o.s ?? 1;
    const r = rot([p[0] * s, p[1] * s, p[2] * s], o.rx || 0, o.ry || 0, o.rz || 0);
    return [r[0] + (o.x || 0), r[1] + (o.y || 0), r[2] + (o.z || 0)];
  }
  _fog(d) { const [a, b] = this.fog; return clamp(1 - (d - a) / (b - a)); }

  render(lt, t) {
    const g = this.g;
    g.clearRect(0, 0, this.W, this.H);
    g.globalCompositeOperation = this.blend;
    for (const o of this.objs) {
      const op = o.opacity ?? 1;
      if (op <= 0.001) continue;
      if (o.update) o.update(lt, t, o);
      const P = o.pts.map((p) => this.project(this._world(o, p)));
      g.fillStyle = g.strokeStyle = o.color || '#fff';
      if (o.type === 'points') {
        const n = Math.floor(P.length * clamp(o.progress ?? 1));
        for (let i = 0; i < n; i++) {
          const p = P[i]; if (!p) continue;
          const a = op * this._fog(p[2]) * (o.twinkle ? 0.55 + 0.45 * Math.sin(t * 4 + i * 1.7) : 1);
          if (a <= 0.01) continue;
          g.globalAlpha = a;
          const r = Math.max(0.6, (o.size || 3) * p[3]);
          if (o.square) g.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
          else { g.beginPath(); g.arc(p[0], p[1], r, 0, 7); g.fill(); }
        }
      } else if (o.type === 'lines') {
        // segs: array of index pairs, or consecutive polyline if o.strip
        const segs = o.segs || P.slice(1).map((_, i) => [i, i + 1]);
        const pr = clamp(o.progress ?? 1) * segs.length;
        g.lineCap = 'round';
        for (let i = 0; i < Math.ceil(pr); i++) {
          const [ia, ib] = segs[i];
          const a = P[ia]; let b = P[ib];
          if (!a || !b) continue;
          const f = Math.min(1, pr - i);
          if (f < 1) b = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, b[2], b[3]];
          g.globalAlpha = op * this._fog((a[2] + b[2]) / 2);
          g.lineWidth = Math.max(0.5, (o.width || 1.5) * (o.scaleWidth === false ? 1 : Math.min(3, (a[3] + b[3]) / 2)));
          g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        }
      } else if (o.type === 'plane') {
        if (P.some((p) => !p)) continue;
        g.globalAlpha = op * this._fog(P.reduce((s, p) => s + p[2], 0) / P.length);
        g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
        if (o.fill !== false) g.fill();
        if (o.stroke) { g.strokeStyle = o.stroke; g.lineWidth = o.width || 1; g.stroke(); }
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  // ---- geometry helpers (return object descriptors) ----
  static points(pts, o = {}) { return { type: 'points', pts, ...o }; }
  static polyline(pts, o = {}) { return { type: 'lines', pts, ...o }; }
  static plane(w, h, o = {}) {
    return { type: 'plane', pts: [[-w / 2, 0, -h / 2], [w / 2, 0, -h / 2], [w / 2, 0, h / 2], [-w / 2, 0, h / 2]], ...o };
  }
  static quad(w, h, o = {}) {
    return { type: 'plane', pts: [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], ...o };
  }
  // Floor grid on the XZ plane (y = 0) as line segments.
  static grid(size = 4000, step = 200, o = {}) {
    const pts = [], segs = [], h = size / 2;
    for (let v = -h; v <= h + 1e-6; v += step) {
      segs.push([pts.length, pts.length + 1]); pts.push([v, 0, -h], [v, 0, h]);
      segs.push([pts.length, pts.length + 1]); pts.push([-h, 0, v], [h, 0, v]);
    }
    return { type: 'lines', pts, segs, width: 1, ...o };
  }
  // Dot lattice on the XZ plane.
  static lattice(size = 4000, step = 160, o = {}) {
    const pts = [], h = size / 2;
    for (let x = -h; x <= h; x += step) for (let z = -h; z <= h; z += step) pts.push([x, 0, z]);
    return { type: 'points', pts, size: 2, ...o };
  }
  static sphere(r = 300, n = 400, o = {}) {
    const pts = [], g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, rr = Math.sqrt(1 - y * y), a = i * g;
      pts.push([Math.cos(a) * rr * r, y * r, Math.sin(a) * rr * r]);
    }
    return { type: 'points', pts, size: 2.5, ...o };
  }
  static ring(r = 300, n = 96, o = {}) {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push([Math.cos(a) * r, 0, Math.sin(a) * r]); }
    return { type: 'lines', pts, ...o };
  }
  static cloud(n = 300, [sx, sy, sz] = [3000, 1500, 3000], o = {}, seed = 7) {
    const r = rng(seed);
    return { type: 'points', pts: Array.from({ length: n }, () => [(r() - 0.5) * sx, (r() - 0.5) * sy, (r() - 0.5) * sz]), size: 2, ...o };
  }
  static box(w = 200, h = 200, d = 200, o = {}) {
    const [x, y, z] = [w / 2, h / 2, d / 2];
    const pts = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    const segs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    return { type: 'lines', pts, segs, ...o };
  }
  // Point along a polyline at fraction f (0..1), for runners/markers following a route.
  static along(pts, f) {
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(...pts[i].map((v, k) => v - pts[i - 1][k])));
    const d = clamp(f) * L[L.length - 1];
    let i = 1; while (i < L.length - 1 && L[i] < d) i++;
    const k = (d - L[i - 1]) / (L[i] - L[i - 1] || 1);
    return pts[i].map((v, j) => pts[i - 1][j] + (v - pts[i - 1][j]) * k);
  }
}
