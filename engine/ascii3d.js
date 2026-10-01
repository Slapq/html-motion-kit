// AsciiSpace: SDF solids raymarched on the GPU, drawn as a character grid (Canvas2D).
// The scene is GLSL you write (`float map(vec3 p)`), the camera and uniforms are plain numbers,
// so every frame is a pure function of time — preview, scrubbing and export all match.
//
//   const sp = new AsciiSpace(el, { map: `float map(vec3 p){ return length(p) - 1.; }`,
//     uniforms: { uR: 1 }, arrays: { uW: 4 }, palette: ['#12C76A', '#2F6BE0', '#EDEDED'] });
//   sp.cam = { eye: [0, 0, -5], look: [0, 0, 0], roll: 0, focal: 1.6 };   // set per frame or tween
//   sp.bind(tl, { before: (t) => { ... set sp.cam / sp.uniforms ... }, mask: (t) => rects });
//   sp.project([x, y, z]) → { x, y, depth, ppu }  (screen px, pixels per world unit) for 3D-anchored text
//
// Shading output per cell: brightness → glyph density (cells below `threshold` stay empty), dominant normal axis → palette colour,
// rim (grazing angle) → accent colour. Cells inside mask rects are left empty so text reads cleanly.
import { link } from './shader.js';

const VERT = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const FRAG = (decl, map, steps, far) => `precision highp float;
varying vec2 uv;
uniform float uTime, uAspect, uRoll, uFocal, uFog;
uniform vec3 uEye, uLook;
${decl}
${map}
vec3 nrm(vec3 p){ vec2 k = vec2(1., -1.) * .002;
  return normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx)); }
void main(){
  vec2 q = uv * 2. - 1.; q.x *= uAspect;
  vec3 f = normalize(uLook - uEye), r = normalize(cross(vec3(0., 1., 0.), f)), u = cross(f, r);
  float c = cos(uRoll), s = sin(uRoll); vec3 r2 = r * c + u * s, u2 = u * c - r * s;
  vec3 rd = normalize(f * uFocal + q.x * r2 + q.y * u2);
  float t = 0.; bool hit = false;
  for (int i = 0; i < ${steps}; i++) { float d = map(uEye + rd * t); if (d < .0015 * t + .001) { hit = true; break; } t += d * .75; if (t > ${far}.) break; }
  if (!hit) { gl_FragColor = vec4(0., 0., 0., 1.); return; }
  vec3 p = uEye + rd * t, n = nrm(p), L = normalize(vec3(.55, .75, -.4));
  float fog = exp(-t * uFog), dif = .55 * max(dot(n, -rd), 0.) + .5 * max(dot(n, L), 0.) + .08;
  float rim = pow(1. - abs(dot(n, -rd)), 3.);
  vec3 a = abs(n); float id = a.x > a.y && a.x > a.z ? .2 : a.y > a.z ? .5 : .8;
  gl_FragColor = vec4(clamp(dif, 0., 1.) * fog, id, rim * fog, 1.);
}`;

export class AsciiSpace {
  constructor(parent, { width, height, cell = [12, 20], map, uniforms = {}, arrays = {}, palette = ['#12C76A', '#2F6BE0', '#EDEDED'],
    accent = '#22E04F', ramp = ' .:-=+*#%@', font = '700 18px "Cascadia Code", Consolas, monospace', steps = 96, far = 60, fog = 0.06, z = 0, threshold = 0.04, levels = [0.42, 0.7, 1] } = {}) {
    const W = (this.W = width ?? parent.clientWidth ?? 1920), H = (this.H = height ?? parent.clientHeight ?? 1080);
    this.cw = cell[0]; this.ch = cell[1];
    this.cols = Math.ceil(W / this.cw); this.rows = Math.ceil(H / this.ch);
    this.cv = Object.assign(document.createElement('canvas'), { width: W, height: H, className: 'ascii-space' });
    Object.assign(this.cv.style, { position: 'absolute', left: 0, top: 0, zIndex: z, pointerEvents: 'none' });
    parent.appendChild(this.cv);
    this.g = this.cv.getContext('2d');
    this.uniforms = { ...uniforms }; this.arrays = {};
    for (const k in arrays) this.arrays[k] = new Float32Array(arrays[k]);
    this.cam = { eye: [0, 0, -5], look: [0, 0, 0], roll: 0, focal: 1.6 };
    this.fog = fog; this.threshold = threshold; this.ramp = ramp; this.font = font; this.name = 'ascii-space';
    this.dust = null; // optional (col, row, t) => [glyph, colour, alpha] | null for empty cells

    // Offscreen GL at grid resolution: one pixel per character cell.
    const gc = document.createElement('canvas'); gc.width = this.cols; gc.height = this.rows;
    const gl = (this.gl = gc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false }));
    if (!gl) throw new Error('AsciiSpace: WebGL unavailable');
    const decl = [...Object.entries(this.uniforms).map(([k, v]) => `uniform ${typeOf(v)} ${k};`),
      ...Object.entries(arrays).map(([k, n]) => `uniform float ${k}[${n}];`)].join('\n');
    this.prog = link(gl, VERT, FRAG(decl, map, steps, far));
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.loc = {}; this.px = new Uint8Array(this.cols * this.rows * 4);

    // Glyph atlas: palette colours + accent, 3 intensity levels each, every ramp glyph.
    this.colours = [...palette, accent];
    const LV = levels, A = (this.atlas = document.createElement('canvas'));
    A.width = this.cw * ramp.length; A.height = this.ch * this.colours.length * LV.length;
    const o = A.getContext('2d'); o.font = font; o.textAlign = 'center'; o.textBaseline = 'middle';
    this.colours.forEach((c, ci) => LV.forEach((lv, li) => {
      o.globalAlpha = lv; o.fillStyle = c;
      [...ramp].forEach((chr, gi) => o.fillText(chr, gi * this.cw + this.cw / 2, (ci * LV.length + li) * this.ch + this.ch / 2 + 1));
    }));
    this.levels = LV.length;
  }

  _set(k, v) {
    const gl = this.gl, l = this.loc[k] ?? (this.loc[k] = gl.getUniformLocation(this.prog, k));
    if (l == null) return;
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v instanceof Float32Array) gl.uniform1fv(l, v);
    else gl[`uniform${v.length}fv`](l, v);
  }

  project(p) {
    const { eye, look, roll = 0, focal = 1.6 } = this.cam;
    const f = norm(sub(look, eye)), r = norm(cross([0, 1, 0], f)), u = cross(f, r);
    const c = Math.cos(roll), s = Math.sin(roll);
    const r2 = add(mul(r, c), mul(u, s)), u2 = sub(mul(u, c), mul(r, s));
    const v = sub(p, eye), dz = dot(v, f);
    if (dz <= 0.05) return null;
    const qx = (focal * dot(v, r2)) / dz, qy = (focal * dot(v, u2)) / dz;
    return { x: this.W / 2 + (qx * this.H) / 2, y: this.H / 2 - (qy * this.H) / 2, depth: dz, ppu: (focal * this.H) / 2 / dz };
  }

  render(t, { mask = [], reveal = 1 } = {}) {
    const { gl, cols, rows, cw, ch, g, px, ramp } = this;
    gl.viewport(0, 0, cols, rows); gl.useProgram(this.prog);
    this._set('uTime', t); this._set('uAspect', this.W / this.H); this._set('uFog', this.fog);
    this._set('uEye', this.cam.eye); this._set('uLook', this.cam.look);
    this._set('uRoll', this.cam.roll || 0); this._set('uFocal', this.cam.focal || 1.6);
    for (const k in this.uniforms) this._set(k, this.uniforms[k]);
    for (const k in this.arrays) this._set(k, this.arrays[k]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);

    g.clearRect(0, 0, this.W, this.H);
    const NG = ramp.length, LV = this.levels, pal = this.colours.length - 1;
    g.font = this.font; g.textBaseline = 'alphabetic';
    const masked = (x, y) => mask.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
    for (let j = 0; j < rows; j++) {
      const src = (rows - 1 - j) * cols * 4, y = j * ch;
      for (let i = 0; i < cols; i++) {
        const x = i * cw;
        if (mask.length && masked(x + cw / 2, y + ch / 2)) continue;
        const k = src + i * 4, b = px[k] / 255;
        if (b < this.threshold) {
          const d = this.dust?.(i, j, t);
          if (d) { g.globalAlpha = d[2]; g.fillStyle = d[1]; g.fillText(d[0], x + 2, y + ch - 4); g.globalAlpha = 1; }
          continue;
        }
        if (reveal < 1 && hash(i, j) > reveal) continue;
        const gi = Math.min(NG - 1, 1 + Math.floor(b * (NG - 1)));
        const rim = px[k + 2] / 255, ci = rim > 0.42 ? pal : px[k + 1] < 90 ? 0 : px[k + 1] < 166 ? 1 : 2;
        const li = Math.min(LV - 1, Math.floor(b * LV * 1.15));
        g.drawImage(this.atlas, gi * cw, (ci * LV + li) * ch, cw, ch, x, y, cw, ch);
      }
    }
  }

  // before(t) runs first (set camera/uniforms), mask(t) returns rects kept empty, reveal(t) dissolves cells in.
  bind(tl, { before, mask, reveal } = {}) {
    tl.add((lt, t) => { before?.(t); this.render(t, { mask: mask?.(t) || [], reveal: reveal ? reveal(t) : 1 }); }, { at: 0, label: 'ascii-space' });
    return this;
  }
}

const hash = (i, j) => { const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return x - Math.floor(x); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
function typeOf(v) {
  if (typeof v === 'number') return 'float';
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4) return `vec${v.length}`;
  throw new Error(`AsciiSpace: unsupported uniform value ${JSON.stringify(v)}`);
}
