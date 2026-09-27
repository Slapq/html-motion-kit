// Preset renderers: lineart, sketch, halftone, pixel, VHS, blueprint, cel ...
//
//   createVideo({ style: 'sketch', scenes: [{ style: { style: 'halftone', cell: 10 } }] })
//   <div data-style="comic">                                 element override
//   style(tl, el, 'lineart', { weight: 2 })                  from build()
//   { op: 'style', target: '.card', params: { style: 'ink', mix: { keys: [[0,1],[2,0]] } } }
//   transition: 'sketch-in'                                   style-name + '-in'
//   style: ['cel', { style: 'vhs', shift: 2 }]               stack
//
// DOM: SVG filters (pure function of t, boil switches between pre-generated variants).
// Space3D: optional hand-drawn strokes (param rough: 0 turns it off).
//
// New: text handling (text: 'skip'|'style'|'jitter'), quality ('draft'|'final'), lightweight.
import { evalSpec, defineOp } from './graph.js';
import { clamp } from './ease.js';
import { Timeline } from './timeline.js';

const NS = 'http://www.w3.org/2000/svg';
const f2 = (x) => +(+x).toFixed(2);
const isObj = (s) => s && typeof s === 'object' && !Array.isArray(s);

// ---------------------------------------------------------------- colors
export function toRGB(c) {
  if (Array.isArray(c)) return c;
  let s = String(c).trim();
  const v = s.match(/^var\((--[\w-]+)\)$/);
  if (v) s = (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(v[1]).trim()) || '#888';
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) return m[1].split(/[\s,/]+/).slice(0, 3).map((x) => parseFloat(x) / 255);
  throw new Error(`style: unsupported color "${c}" (use #hex, rgb() or var(--name))`);
}
const css = (c) => `rgb(${toRGB(c).map((x) => Math.round(clamp(x) * 255)).join(',')})`;

// ---------------------------------------------------------------- filter primitives (lightweight)
const F = {
  flood: (o, c) => `<feFlood flood-color="${css(c)}" result="${o}"/>`,
  // grayscale luminance
  lum: (i, o) => `<feColorMatrix in="${i}" type="matrix" values="0.21 0.72 0.07 0 0 0.21 0.72 0.07 0 0 0.21 0.72 0.07 0 0 0 0 0 1 0" result="${o}"/>`,
  // linear transform per channel
  lin: (i, o, s, b) => `<feComponentTransfer in="${i}" result="${o}"><feFuncR type="linear" slope="${f2(s)}" intercept="${f2(b)}"/><feFuncG type="linear" slope="${f2(s)}" intercept="${f2(b)}"/><feFuncB type="linear" slope="${f2(s)}" intercept="${f2(b)}"/></feComponentTransfer>`,
  contrast: (i, o, k, mid = 0.5) => F.lin(i, o, k, mid - k * mid),
  posterize: (i, o, n) => {
    const N = Math.max(2, Math.round(n)), vals = Array.from({ length: N }, (_, k) => f2(k / (N - 1))).join(' ');
    return `<feComponentTransfer in="${i}" result="${o}"><feFuncR type="discrete" tableValues="${vals}"/><feFuncG type="discrete" tableValues="${vals}"/><feFuncB type="discrete" tableValues="${vals}"/></feComponentTransfer>`;
  },
  blur: (i, o, s) => `<feGaussianBlur in="${i}" stdDeviation="${f2(Math.max(0, s))}" result="${o}"/>`,
  sat: (i, o, s) => `<feColorMatrix in="${i}" type="saturate" values="${f2(s)}" result="${o}"/>`,
  mul: (a, b, o) => `<feBlend in="${a}" in2="${b}" mode="multiply" result="${o}"/>`,
  screen: (a, b, o) => `<feBlend in="${a}" in2="${b}" mode="screen" result="${o}"/>`,
  add: (a, b, o, ka = 1, kb = 1) => `<feComposite in="${a}" in2="${b}" operator="arithmetic" k1="0" k2="${f2(ka)}" k3="${f2(kb)}" k4="0" result="${o}"/>`,
  lerp: (a, b, o, k) => `<feComposite in="${a}" in2="${b}" operator="arithmetic" k1="0" k2="${f2(k)}" k3="${f2(1 - k)}" k4="0" result="${o}"/>`,
  turb: (o, freq, oct, seed) => `<feTurbulence type="fractalNoise" baseFrequency="${f2(freq)}" numOctaves="${oct}" seed="${seed}" result="${o}"/>`,
  disp: (i, map, o, scale) => `<feDisplacementMap in="${i}" in2="${map}" scale="${f2(scale)}" xChannelSelector="R" yChannelSelector="G" result="${o}"/>`,
  offset: (i, o, dx, dy = 0) => `<feOffset in="${i}" dx="${f2(dx)}" dy="${f2(dy)}" result="${o}"/>`,
  dilate: (i, o, r) => (r > 0 ? `<feMorphology in="${i}" operator="dilate" radius="${f2(r)}" result="${o}"/>` : F.offset(i, o, 0)),
  erode: (i, o, r) => (r > 0 ? `<feMorphology in="${i}" operator="erode" radius="${f2(r)}" result="${o}"/>` : F.offset(i, o, 0)),
  img: (o, svg, W, H) => `<feImage href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" result="${o}"/>`,
  // outline mask from alpha: 1 paper, 0 line (dilated - original alpha)
  outline: (i, o, w) => {
    if (w <= 0) return F.offset(i, o, 0);
    return F.dilate(i, `${o}_d`, w) + `<feComposite in="${o}_d" in2="SourceAlpha" operator="out" result="${o}"/>`;
  },
  // paper + ink through mask (mask=1 shows ink, mask=0 shows paper)
  inkOn: (m, o, paper, ink) => F.flood(`${o}_i`, ink) + F.flood(`${o}_p`, paper) + `<feComposite in="${o}_i" in2="${m}" operator="in" result="${o}_ln"/><feComposite in="${o}_p" in2="${m}" operator="out" result="${o}_bg"/>` + F.add(`${o}_bg`, `${o}_ln`, o),
};

// ---------------------------------------------------------------- patterns (halftone screens, textures)
const tile = (s, a, body, defs = '') =>
  `<defs>${defs}<pattern id="p" width="${s}" height="${s}" patternUnits="userSpaceOnUse" patternTransform="rotate(${f2(a)})">${body}</pattern></defs>`;
export const PATTERNS = {
  dots: ({ size, angle, width }) => tile(size, angle, `<rect width="${size}" height="${size}" fill="#fff"/><circle cx="${size / 2}" cy="${size / 2}" r="${f2(width)}"/>`),
  lines: ({ size, angle, width }) => tile(size, angle, `<rect width="${size}" height="${size}" fill="#fff"/><rect width="${size}" height="${f2(width)}"/>`),
  grid: ({ size, width }) => tile(size, 0, `<rect width="${size}" height="${size}" fill="#fff"/><rect width="${size}" height="${f2(width)}"/><rect width="${f2(width)}" height="${size}"/>`),
  dotscreen: ({ size, angle }) => tile(size, angle, `<rect width="${size}" height="${size}" fill="url(#g)"/>`,
    `<radialGradient id="g" cx="${size / 2}" cy="${size / 2}" r="${f2(size * 0.71)}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>`),
};
function pattern(kind, o, e, opts) {
  const P = PATTERNS[kind];
  if (!P) throw new Error(`style: unknown pattern "${kind}"`);
  const svg = `<svg xmlns="${NS}" width="${e.W}" height="${e.H}">${P({ size: 12, angle: 0, width: 2, ...opts })}<rect width="100%" height="100%" fill="url(#p)"/></svg>`;
  return F.img(o, svg, e.W, e.H);
}

// ---------------------------------------------------------------- registry
export const COMMON = { mix: 1, seed: 1, boil: 0, rough: 1, text: 'skip', quality: 'final' };
export const STYLES = {};
export function registerStyle(name, def) {
  const base = def.extends ? STYLES[def.extends] : null;
  if (def.extends && !base) throw new Error(`style: "${name}" extends unknown style "${def.extends}"`);
  const d = { ...base, ...def, params: { ...COMMON, ...base?.params, ...def.params }, rough: def.rough === undefined ? base?.rough : def.rough };
  if (typeof d.filter !== 'function') throw new Error(`style: "${name}" needs filter(p, e)`);
  return (STYLES[name] = d);
}

// 'sketch' | { style: 'ink', weight: 2 } | ['cel', 'vhs'] | 'none' → [{ name, params }]
export function resolveStyle(spec) {
  if (spec == null || spec === false || spec === 'none' || spec === '') return [];
  if (Array.isArray(spec)) return spec.flatMap(resolveStyle);
  if (typeof spec === 'string') {
    const s = spec.trim();
    if (s[0] === '{' || s[0] === '[') return resolveStyle(JSON.parse(s));
    const names = s.split(/[\s,+]+/).filter(Boolean);
    if (names.length > 1) return names.flatMap(resolveStyle);
    spec = { style: s };
  }
  if (!isObj(spec) || typeof spec.style !== 'string') throw new Error('style: expected a name, { style, ...params } or an array');
  if (spec.style === 'none') return [];
  if (!STYLES[spec.style]) throw new Error(`style: unknown style "${spec.style}"`);
  const { style: name, ...params } = spec;
  return [{ name, params }];
}

// Evaluate params at time t (animation specs: keys/fx/expr/link).
export function styleParams(layer, env = {}) {
  const def = STYLES[layer.name], out = {};
  const all = { ...def.params, ...layer.params };
  for (const k in all) out[k] = evalSpec(all[k], { t: env.t ?? 0, gt: env.gt ?? env.t ?? 0, i: 0, graph: env.graph, def: def.params[k] });
  return out;
}
const seedOf = (p, t) => {
  const s0 = (Math.round(p.seed * 97) % 90000) + 1;
  return [s0, s0 + (p.boil > 0 ? Math.floor(t * p.boil + 1e-6) : 0)];
};

// Full filter markup for a style stack at time t (pure: same inputs → same string).
//   env: { t, gt, W, H, clip, bg, graph, quality }
export function styleMarkup(layers, env = {}) {
  const W = env.W ?? 1920, H = env.H ?? 1080, t = env.t ?? 0, quality = env.quality ?? 'final';
  let prev = 'SourceGraphic', m = '';
  layers.forEach((L, k) => {
    const def = STYLES[L.name], p = styleParams(L, env);
    const mix = clamp(p.mix) * clamp(env.mix ?? 1);
    if (!(mix > 0.0005)) return;
    const [seed0, seed] = seedOf(p, t);
    const e = { t, W, H, seed0, seed, bg: env.bg ?? '#fff', p, quality };
    const boilVar = p.boil > 0 ? (seed % 4) : 0;
    const body = def.filter(p, e, boilVar) + (mix < 0.9995 ? F.lerp('out', 'IN', 'mixed', mix) : F.offset('out', 'mixed', 0));
    const ns = `s${k}_`;
    m += body.replace(/\b(in2?|result)="([^"]+)"/g, (_, a, v) =>
      `${a}="${v === 'IN' ? prev : /^(SourceGraphic|SourceAlpha)$/.test(v) ? v : ns + v}"`);
    prev = ns + 'mixed';
  });
  if (!m) return '';
  return m + (env.clip ? `<feComposite in="${prev}" in2="SourceGraphic" operator="in"/>` : F.offset(prev, 'final', 0));
}

// Hand-drawn stroke settings for Space3D (null = off).
export function roughAt(layers, env = {}) {
  let R = null;
  for (const L of layers) {
    const def = STYLES[L.name];
    if (!def.rough) continue;
    const p = styleParams(L, env);
    const k = (p.rough ?? 1) * clamp(p.mix) * clamp(env.mix ?? 1);
    if (!(k > 0.001)) continue;
    const [, seed] = seedOf(p, env.t ?? 0);
    R = { passes: 1, hatch: false, gap: 0, angle: 0, seed, ...def.rough };
    R.amp = (R.amp ?? 1) * k;
  }
  return R;
}

// ---------------------------------------------------------------- built-in styles (lightweight)
const unit = (H) => Math.max(2, H / 360);  // 1080p → 3px, 720p → 2px, scale-aware

registerStyle('lineart', {
  params: { weight: 1.5, ink: '#222', paper: '#faf8f5' },
  filter: (p, e) => {
    const w = unit(e.H) * p.weight;
    return F.outline('SourceAlpha', 'mask', w) +
      F.flood('ink', p.ink) +
      `<feComposite in="ink" in2="mask" operator="in" result="lines"/>` +
      `<feComposite in="lines" in2="SourceGraphic" operator="over" result="out"/>`;
  },
  desc: 'Clean line art with adjustable weight',
});

registerStyle('sketch', {
  params: { weight: 1.2, ink: '#2a2a2a', paper: '#f4f1e8', grain: 0.12 },
  filter: (p, e, v) => {
    const w = unit(e.H) * p.weight, g = p.grain * (e.quality === 'draft' ? 0.5 : 1);
    return F.outline('SourceAlpha', 'mask', w) +
      (g > 0 ? F.turb('n', 0.8, 2, e.seed + v) + F.lum('n', 'nl') + F.contrast('nl', 'ng', 3) + F.lin('ng', 'ngk', g * 0.4, 1 - g * 0.4) + F.mul('mask', 'ngk', 'mask2') : F.offset('mask', 'mask2', 0)) +
      (v > 0 ? F.turb('d', 0.03, 1, e.seed0 + v * 13) + F.disp('mask2', 'd', 'mask3', w * 0.6) : F.offset('mask2', 'mask3', 0)) +
      F.flood('ink', p.ink) +
      `<feComposite in="ink" in2="mask3" operator="in" result="lines"/>` +
      `<feComposite in="lines" in2="SourceGraphic" operator="over" result="out"/>`;
  },
  rough: { amp: 1.2, passes: 2 },
  desc: 'Hand-drawn sketch with grain and boil',
});

registerStyle('ink', {
  params: { weight: 1.8, ink: '#1a1a1a', paper: '#f9f6f0', bleed: 0.8 },
  filter: (p, e) => {
    const w = unit(e.H) * p.weight;
    return F.outline('SourceAlpha', 'mask', w) +
      (p.bleed > 0 && e.quality === 'final' ? F.turb('t', 0.015, 3, e.seed0) + F.disp('mask', 't', 'mask2', w * p.bleed * 0.5) + F.blur('mask2', 'mask3', w * 0.3) : F.blur('mask', 'mask3', w * 0.2)) +
      F.flood('ink', p.ink) +
      `<feComposite in="ink" in2="mask3" operator="in" result="lines"/>` +
      `<feComposite in="lines" in2="SourceGraphic" operator="over" result="out"/>`;
  },
  desc: 'Ink with bleed on textured paper',
});

registerStyle('watercolor', {
  params: { weight: 0.8, sat: 1.2, paper: '#fefdfb' },
  filter: (p, e) => {
    const w = unit(e.H) * p.weight;
    return F.outline('SourceAlpha', 'mask', w) +
      (e.quality === 'final' ? F.turb('t1', 0.01, 3, e.seed0) + F.turb('t2', 0.05, 2, e.seed0 + 7) + F.disp('SourceGraphic', 't1', 'd1', e.H * 0.02) + F.blur('d1', 'd2', w * 1.5) + F.disp('d2', 't2', 'd3', e.H * 0.01) : F.blur('SourceGraphic', 'd3', w * 1.2)) +
      F.sat('d3', 'd4', p.sat) + F.flood('pf', p.paper) + `<feComposite in="d4" in2="pf" operator="over" result="d5"/>` +
      `<feComposite in="d5" in2="mask" operator="in" result="out"/>`;
  },
  desc: 'Watercolor with bleed and saturation',
});

registerStyle('halftone', {
  params: { cell: 12, shape: 'dot', angle: 15 },
  filter: (p, e) => {
    const c = Math.max(6, p.cell * unit(e.H) / 3);
    return F.lum('SourceGraphic', 'l') + pattern(p.shape === 'dot' ? 'dotscreen' : 'lines', 'pat', e, { size: c, angle: p.angle }) +
      `<feComposite in="l" in2="pat" operator="in" result="out"/>`;
  },
  desc: 'CMYK-style halftone screen',
});

registerStyle('pixel', {
  params: { cell: 8, levels: 4, palette: null },
  filter: (p, e) => {
    const c = Math.max(4, p.cell * unit(e.H) / 3), W = e.W, H = e.H, cw = Math.ceil(W / c), ch = Math.ceil(H / c);
    const grid = `<svg xmlns="${NS}" width="${W}" height="${H}"><defs><pattern id="g" width="${c}" height="${c}" patternUnits="userSpaceOnUse"><rect width="${c}" height="${c}" fill="#000"/><rect x="0.5" y="0.5" width="${c - 1}" height="${c - 1}" fill="#fff"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    return (p.palette ? (() => { const C = p.palette.map(toRGB), fn = (k) => `type="discrete" tableValues="${C.map((c) => f2(c[k])).join(' ')}"`; return `<feComponentTransfer in="SourceGraphic" result="pal"><feFuncR ${fn(0)}/><feFuncG ${fn(1)}/><feFuncB ${fn(2)}/></feComponentTransfer>`; })() : F.posterize('SourceGraphic', 'pal', p.levels)) +
      F.img('grid', grid, W, H) + `<feComposite in="pal" in2="grid" operator="in" result="out"/>`;
  },
  desc: 'Pixelated retro style',
});

registerStyle('vhs', {
  params: { shift: 1.5, noise: 0.15, lines: 2 },
  filter: (p, e, v) => {
    const s = p.shift * unit(e.H) * 0.5, n = p.noise * (e.quality === 'draft' ? 0.5 : 1), l = p.lines;
    return (s > 0 ? `<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="gb"/><feOffset in="r" dx="${f2(s * (v === 1 ? -1 : v === 2 ? 1.2 : v === 3 ? -0.8 : 0))}" result="rr"/><feOffset in="gb" dx="${f2(-s * 0.5)}" result="gbb"/><feComposite in="rr" in2="gbb" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="c"/>` : F.offset('SourceGraphic', 'c', 0)) +
      (n > 0 ? F.turb('tn', 1.2 * (1 + v * 0.1), 1, e.seed + v * 17) + F.lum('tn', 'tnl') + F.contrast('tnl', 'tnc', 2) + F.lin('tnc', 'tnk', n * 0.3, 1 - n * 0.15) + F.mul('c', 'tnk', 'cn') : F.offset('c', 'cn', 0)) +
      (l > 0 ? pattern('lines', 'lp', e, { size: l * unit(e.H), angle: 0, width: l * unit(e.H) * 0.4 }) + F.lin('lp', 'lpk', 0.05, 0.95) + F.mul('cn', 'lpk', 'out') : F.offset('cn', 'out', 0));
  },
  desc: 'VHS chromatic shift, noise and scanlines',
});

registerStyle('blueprint', {
  params: { weight: 1, grid: 16 },
  filter: (p, e) => {
    const w = unit(e.H) * p.weight, g = p.grid * unit(e.H) / 3;
    return F.outline('SourceAlpha', 'mask', w) + F.lin('mask', 'inv', -1, 1) +
      (g > 0 ? pattern('grid', 'gp', e, { size: g, width: Math.max(1, g * 0.05) }) + F.lin('gp', 'gpk', 0.15, 0.85) + F.mul('inv', 'gpk', 'inv2') : F.offset('inv', 'inv2', 0)) +
      F.flood('bg', '#0a3d5c') + F.flood('fg', '#c9e7f5') +
      `<feComposite in="bg" in2="inv2" operator="in" result="dark"/><feComposite in="fg" in2="inv2" operator="out" result="light"/>` +
      F.add('dark', 'light', 'out');
  },
  desc: 'Blueprint with grid on dark background',
});

registerStyle('cel', {
  params: { tiers: 3, sat: 1.1 },
  filter: (p, e) => F.posterize('SourceGraphic', 'post', p.tiers) + F.sat('post', 'out', p.sat),
  desc: 'Cel-shaded animation style',
});

registerStyle('comic', {
  extends: 'cel',
  params: { tiers: 4, weight: 1.2, ink: '#000' },
  filter: (p, e) => F.posterize('SourceGraphic', 'post', p.tiers) + F.sat('post', 'sat', 1.15) +
    F.outline('SourceAlpha', 'mask', unit(e.H) * p.weight) + F.flood('inkf', p.ink) +
    `<feComposite in="inkf" in2="mask" operator="out" result="line"/><feComposite in="sat" in2="line" operator="over" result="out"/>`,
  desc: 'Comic book: cel + outlines',
});

registerStyle('duotone', {
  params: { dark: '#2a2a55', light: '#f5e8c9' },
  filter: (p, e) => {
    const A = toRGB(p.dark), B = toRGB(p.light), row = (k) => [0, 1, 2].map((j) => (j === k ? f2(B[k] - A[k]) : 0)).join(' ') + ` 0 ${f2(A[k])}`;
    return F.lum('SourceGraphic', 'l') + `<feColorMatrix in="l" type="matrix" values="${row(0)} ${row(1)} ${row(2)} 0 0 0 0 1" result="out"/>`;
  },
  desc: 'Two-tone color mapping',
});

registerStyle('riso', {
  params: { colors: ['#ff5c8d', '#0078bf', '#ffe800'], cell: 10 },
  filter: (p, e) => {
    const c = Math.max(6, p.cell * unit(e.H) / 3), C = p.colors.slice(0, 3);
    let m = F.lum('SourceGraphic', 'l');
    C.forEach((col, i) => {
      const a = i * 15;
      m += pattern('dotscreen', `p${i}`, e, { size: c, angle: a }) +
        `<feComposite in="l" in2="p${i}" operator="in" result="m${i}"/>` +
        F.flood(`c${i}`, col) + `<feComposite in="c${i}" in2="m${i}" operator="in" result="l${i}"/>`;
    });
    m += F.screen('l0', 'l1', 's01');
    if (C.length > 2) m += F.screen('s01', 'l2', 'out'); else m += F.offset('s01', 'out', 0);
    return m;
  },
  desc: 'Risograph print with layered screens',
});

// Variants
registerStyle('pencil', { extends: 'sketch', params: { weight: 0.9, grain: 0.18 } });
registerStyle('charcoal', { extends: 'sketch', params: { weight: 1.8, ink: '#1a1a1a', grain: 0.25 } });
registerStyle('popart', { extends: 'halftone', params: { cell: 14, shape: 'dot' } });
registerStyle('gameboy', { extends: 'pixel', params: { cell: 6, palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] } });
registerStyle('retro8', { extends: 'pixel', params: { cell: 8, palette: ['#000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'] } });
registerStyle('crt', { extends: 'vhs', params: { shift: 0.8, lines: 3 } });

registerStyle('jitter-text', {
  params: { amp: 1.5 },
  filter: (p, e, v) => {
    const a = p.amp * unit(e.H) * 0.4;
    return v > 0 ? F.turb('d', 0.02, 1, e.seed0 + v * 11) + F.disp('SourceGraphic', 'd', 'out', a) : F.offset('SourceGraphic', 'out', 0);
  },
  desc: 'Hand-drawn text jitter (use with text: "style")',
});

// ---------------------------------------------------------------- DOM layer
export const composeFilter = (el) => [...Object.values(el._styleSlots || {}), el._tlFilter].filter(Boolean).join(' ');
let defs = null, uid = 0;
function defsHost() {
  if (defs?.isConnected) return defs;
  defs = document.createElementNS(NS, 'svg');
  defs.setAttribute('class', 'style-defs');
  defs.setAttribute('aria-hidden', 'true');
  Object.assign(defs.style, { position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' });
  document.body.appendChild(defs);
  return defs;
}
const opaque = (c) => c && !/^rgba\(.*,\s*0\)$|^transparent$/.test(c.replace(/\s+/g, ' '));
function backdropOf(el, self) {
  for (let n = self ? el : el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (opaque(c)) return c;
  }
  return '#fff';
}

// style(tl, el, spec, { slot, clip, graph, i, mix, quality }) → { layers, params, remove(), id }
export function style(tl, el, spec, opts = {}) {
  const layers = resolveStyle(spec).map((L) => ({ name: L.name, params: { ...STYLES[L.name].params, ...L.params } }));
  const slot = opts.slot || 'base', slots = (el._styleSlots ||= {});
  const handle = { layers, params: layers[0]?.params || {}, remove: () => { delete slots[slot]; el.style.filter = composeFilter(el); } };
  if (!layers.length) { handle.remove(); return handle; }

  const W = el.offsetWidth || tl._root.width || 1920, H = el.offsetHeight || tl._root.height || 1080;
  const clip = opts.clip ?? true, bg = opts.bg || backdropOf(el, !clip);
  const quality = opts.quality ?? (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('export') ? 'final' : 'draft');

  // Text handling: skip (default), style, jitter
  const text = layers[0]?.params.text ?? 'skip';
  if (text === 'skip') {
    const txtEls = [...el.querySelectorAll('*')].filter((n) => {
      const tag = n.tagName.toLowerCase();
      return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'label', 'a', 'button'].includes(tag) &&
        [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    });
    for (const t of txtEls) {
      if (!t.style.filter) t.style.filter = 'none';
      if (!t.style.color) {
        const ink = layers[0]?.params.ink || '#222';
        t.style.color = ink;
      }
    }
  }

  const f = document.createElementNS(NS, 'filter'), id = `hmk-style-${++uid}`;
  for (const [k, v] of Object.entries({ id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H, 'color-interpolation-filters': 'sRGB' }))
    f.setAttribute(k, v);
  defsHost().appendChild(f);

  let last = null;
  const env = (lt, t) => ({ t: lt, gt: t, W, H, clip, bg, graph: opts.graph, i: opts.i, mix: evalSpec(opts.mix ?? 1, { t: lt, gt: t, i: 0, def: 1 }), quality });
  tl.trace(`style:${layers.map((L) => L.name).join('+')}`, () => tl.add((lt, t) => {
    const m = styleMarkup(layers, env(lt, t));
    if (m !== last) { f.innerHTML = m; last = m; }
    const url = m ? `url(#${id})` : '';
    if ((slots[slot] || '') !== url) { if (url) slots[slot] = url; else delete slots[slot]; }
    const fs = composeFilter(el);
    if (el.style.filter !== fs) el.style.filter = fs;
  }));

  // Space3D rough strokes
  if (layers.some((L) => STYLES[L.name].rough)) {
    const o = tl._o, cvs = el.matches?.('canvas.fx-space') ? [el] : [...(el.querySelectorAll?.('canvas.fx-space') || [])];
    for (const cv of cvs) (cv._roughFns ||= {})[id] = (t) => roughAt(layers, env(t - o, t));
  }

  handle.id = id;
  return handle;
}

// Scene-level style with element overrides.
export function styleScene(tl, sceneEl, spec, opts = {}) {
  const own = [...sceneEl.querySelectorAll('[data-style]')];
  const out = [];
  if (spec && resolveStyle(spec).length) {
    if (!own.length) out.push(style(tl, sceneEl, spec, { clip: false, ...opts }));
    else {
      const back = document.createElement('div');
      back.className = 'style-backdrop';
      Object.assign(back.style, { position: 'absolute', inset: 0, background: 'inherit', zIndex: -1, pointerEvents: 'none' });
      sceneEl.prepend(back);
      out.push(style(tl, back, spec, { clip: false, bg: backdropOf(sceneEl, true), ...opts }));
      const walk = (n) => {
        for (const c of n.children) {
          if (c === back || c.hasAttribute('data-style')) continue;
          if (c.querySelector('[data-style]')) walk(c); else out.push(style(tl, c, spec, opts));
        }
      };
      walk(sceneEl);
    }
  }
  for (const e of own) out.push(style(tl, e, e.dataset.style, opts));
  return out;
}

// Style transitions: 'sketch-in' or { type: 'style', style }.
export function styleTransition(tr) {
  const type = tr?.type;
  const spec = type === 'style' ? tr.style : typeof type === 'string' && type.endsWith('-in') && STYLES[type.slice(0, -3)] ? { style: type.slice(0, -3), ...tr.params } : null;
  if (!spec) return null;
  return (tl, a, b, d) => {
    const q = (x) => +(x * d).toFixed(4);
    if (a) style(tl, a, spec, { slot: 'tr-out', clip: false, mix: { keys: [[0, 0], [q(0.5), 1, 'inOutQuad']] } });
    style(tl, b, spec, { slot: 'tr-in', clip: false, mix: { keys: [[q(0.45), 1], [d, 0, 'inOutQuad']] } });
    tl.fromTo(b, { opacity: 0 }, { opacity: 1 }, { at: q(0.25), dur: q(0.35), ease: 'inOutQuad' });
  };
}

defineOp('style', {
  target: 'many',
  params: { style: 'sketch' },
  apply: (tl, els, p, g) => {
    const { style: name, ...rest } = p, spec = typeof name === 'string' && !name.includes(' ') ? { style: name, ...rest } : name;
    els.forEach((el, i) => style(tl, el, spec, { graph: g, i, n: els.length }));
  },
});

Timeline.prototype.style = function (el, spec, params) { return style(this, el, params && typeof spec === 'string' ? { style: spec, ...params } : spec); };
