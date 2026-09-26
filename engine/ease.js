// Easing, math and deterministic randomness. Everything here is pure so that
// any frame can be computed from time alone (required for frame-exact export).
const c1 = 1.70158, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;

const outBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  inCubic: (t) => t ** 3,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t) => 1 - (1 - t) ** 4,
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  outExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  inBack: (t) => c3 * t ** 3 - c1 * t * t,
  outBack: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  outElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,
  outBounce,
  // Critically-damped-ish spring, settles at 1.
  spring: (t) => 1 - Math.exp(-6 * t) * Math.cos(8 * t),
};

export const resolveEase = (e) =>
  typeof e === 'function' ? e : ease[e] || ease.outCubic;

export const lerp = (a, b, p) => a + (b - a) * p;
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Seeded PRNG (mulberry32).
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hash-based 1D value noise in [-1, 1], smooth and seekable.
const hash = (n, seed) => {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
export function noise(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i, seed), hash(i + 1, seed), u) * 2 - 1;
}

// Pre-computed per-frame envelopes (audio analysis, data channels). Pure lookup → seekable.
export const ENVELOPES = {};
export function registerEnvelope(name, data, fps = 60) {
  ENVELOPES[name] = { data: Float32Array.from(data), fps };
  return ENVELOPES[name];
}
export function envAt(name, t) {
  const e = ENVELOPES[name];
  if (!e) throw new Error(`unknown envelope "${name}" (analyzeAudio / registerEnvelope first)`);
  const f = Math.max(0, t) * e.fps, i = Math.floor(f), d = e.data;
  if (i >= d.length - 1) return d[d.length - 1] ?? 0;
  return lerp(d[i], d[i + 1], f - i);
}
