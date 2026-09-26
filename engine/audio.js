import { ENVELOPES, registerEnvelope } from './ease.js';
export { ENVELOPES, registerEnvelope };

// Procedural sound effects (no asset files) + audio-file cues.
// The same graph builder is used for live playback (AudioContext) and for
// export (OfflineAudioContext -> WAV), so preview and final video match.

function noiseBuffer(ctx, sec = 1) {
  const len = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    d[i] = (s / 4294967296) * 2 - 1;
  }
  return b;
}

function env(g, t, a, peak, dur, curve = 'exp') {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  else g.gain.linearRampToValueAtTime(0.0001, t + dur);
}

function tone(ctx, out, t, { type = 'sine', f0, f1 = f0, dur = 0.2, vol = 0.3, a = 0.005 }) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, a, vol, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(ctx, out, t, { dur = 0.4, vol = 0.3, type = 'bandpass', f0 = 800, f1 = f0, q = 1, a = 0.01, curve }) {
  const src = ctx.createBufferSource();
  src.buffer = ctx._nb || (ctx._nb = noiseBuffer(ctx, 2));
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  env(g, t, a, vol, dur, curve);
  src.connect(f).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.05);
}

// Each preset: (ctx, destination, time, opts) -> void. Add your own with registerSfx.
export const SFX = {
  whoosh: (c, o, t, p) => noise(c, o, t, { dur: p.dur ?? 0.45, vol: 0.35 * (p.volume ?? 1), f0: 300, f1: 3200, q: 0.8, a: 0.18, curve: 'lin' }),
  swoosh: (c, o, t, p) => noise(c, o, t, { dur: p.dur ?? 0.3, vol: 0.3 * (p.volume ?? 1), f0: 2500, f1: 400, q: 1.2, a: 0.03 }),
  pop: (c, o, t, p) => tone(c, o, t, { f0: 900, f1: 200, dur: 0.12, vol: 0.35 * (p.volume ?? 1) }),
  click: (c, o, t, p) => {
    tone(c, o, t, { type: 'square', f0: 2200, f1: 1200, dur: 0.03, vol: 0.12 * (p.volume ?? 1) });
    noise(c, o, t, { dur: 0.03, vol: 0.2 * (p.volume ?? 1), type: 'highpass', f0: 3000 });
  },
  tick: (c, o, t, p) => tone(c, o, t, { type: 'triangle', f0: 1800, dur: 0.04, vol: 0.12 * (p.volume ?? 1) }),
  type: (c, o, t, p) => noise(c, o, t, { dur: 0.025, vol: 0.18 * (p.volume ?? 1), type: 'bandpass', f0: 2600 + (p.seed ?? 0) % 7 * 150, q: 3 }),
  ding: (c, o, t, p) => {
    const v = p.volume ?? 1;
    tone(c, o, t, { f0: 1318.5, dur: 1.2, vol: 0.22 * v });
    tone(c, o, t, { f0: 2637, dur: 0.6, vol: 0.06 * v });
  },
  success: (c, o, t, p) => {
    const v = p.volume ?? 1;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(c, o, t + i * 0.08, { type: 'triangle', f0: f, dur: 0.5, vol: 0.18 * v }));
  },
  error: (c, o, t, p) => {
    const v = p.volume ?? 1;
    tone(c, o, t, { type: 'sawtooth', f0: 220, dur: 0.18, vol: 0.12 * v });
    tone(c, o, t + 0.2, { type: 'sawtooth', f0: 165, dur: 0.3, vol: 0.12 * v });
  },
  rise: (c, o, t, p) => {
    const d = p.dur ?? 1.2, v = p.volume ?? 1;
    tone(c, o, t, { type: 'sawtooth', f0: 110, f1: 880, dur: d, vol: 0.06 * v, a: d * 0.9 });
    noise(c, o, t, { dur: d, vol: 0.2 * v, f0: 400, f1: 6000, a: d * 0.9, curve: 'lin' });
  },
  impact: (c, o, t, p) => {
    const v = p.volume ?? 1;
    tone(c, o, t, { f0: 140, f1: 38, dur: 0.6, vol: 0.7 * v });
    noise(c, o, t, { dur: 0.35, vol: 0.35 * v, type: 'lowpass', f0: 2000, f1: 200 });
  },
  sparkle: (c, o, t, p) => {
    const v = p.volume ?? 1;
    [2093, 2637, 3136, 3951, 3136].forEach((f, i) =>
      tone(c, o, t + i * 0.05, { f0: f, dur: 0.25, vol: 0.07 * v }));
  },
  glitch: (c, o, t, p) => {
    const v = p.volume ?? 1;
    for (let i = 0; i < 6; i++) {
      tone(c, o, t + i * 0.035, { type: 'square', f0: 200 + ((i * 739) % 1600), dur: 0.03, vol: 0.08 * v });
    }
  },
  scan: (c, o, t, p) => {
    const v = p.volume ?? 1, d = p.dur ?? 0.5;
    tone(c, o, t, { type: 'square', f0: 3000, f1: 600, dur: d, vol: 0.04 * v });
    noise(c, o, t, { dur: d, vol: 0.18 * v, type: 'bandpass', f0: 6000, f1: 1200, q: 6, a: 0.02 });
  },
  bass: (c, o, t, p) => {
    const v = p.volume ?? 1;
    tone(c, o, t, { f0: 90, f1: 32, dur: p.dur ?? 1.4, vol: 0.8 * v, a: 0.003 });
    tone(c, o, t, { type: 'sawtooth', f0: 55, f1: 30, dur: 0.5, vol: 0.12 * v });
    noise(c, o, t, { dur: 0.25, vol: 0.4 * v, type: 'lowpass', f0: 3000, f1: 150 });
  },
  hud: (c, o, t, p) => {
    const v = p.volume ?? 1;
    tone(c, o, t, { type: 'sine', f0: 1760, dur: 0.07, vol: 0.1 * v });
    tone(c, o, t + 0.08, { type: 'sine', f0: 2349, dur: 0.09, vol: 0.08 * v });
  },
  // Procedural techno bed: kick / hat / sub pulse for `dur` seconds at `bpm`.
  beat: (c, o, t, p) => {
    const v = p.volume ?? 1, bpm = p.bpm ?? 120, dur = p.dur ?? 8, b = 60 / bpm, fade = p.fade ?? 1.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + (p.fadeIn ?? 0.5));
    g.gain.setValueAtTime(v, t + Math.max(0, dur - fade)); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    let bus = g;
    if (p.warm) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; g.connect(lp).connect(o); } else g.connect(o);
    const kv = p.warm ? 0.4 : 0.55, hv = p.warm ? 0.5 : 1;
    const pat = p.pattern ?? 'x...x...x...x...', hats = p.hats ?? true;
    for (let i = 0, s = t; s < t + dur; i++, s += b / 4) {
      if (pat[i % pat.length] === 'x') tone(c, bus, s, { f0: 150, f1: 42, dur: 0.28, vol: kv, a: p.warm ? 0.006 : 0.002 });
      if (hats && i % 4 === 2) noise(c, bus, s, { dur: 0.05, vol: 0.12 * hv, type: 'highpass', f0: 8000, a: 0.002 });
      if (hats && i % 2 === 1) noise(c, bus, s, { dur: 0.02, vol: 0.04 * hv, type: 'highpass', f0: 10000, a: 0.001 });
      if (p.sub !== false && i % 4 === 2) tone(c, bus, s, { type: 'triangle', f0: p.root ?? 55, dur: b * 0.45, vol: 0.18, a: 0.01 });
    }
  },
  // ---- soft / designed set: rounded attacks, filtered, meant to sit under music ----
  air: (c, o, t, p) => { // airy transition swell
    const v = p.volume ?? 1, d = p.dur ?? 0.7;
    noise(c, o, t, { dur: d, vol: 0.14 * v, type: 'bandpass', f0: 500, f1: 2400, q: 0.6, a: d * 0.55, curve: 'lin' });
  },
  thump: (c, o, t, p) => { // warm low accent, no click
    const v = p.volume ?? 1;
    tone(c, o, t, { f0: 70, f1: 40, dur: p.dur ?? 0.9, vol: 0.38 * v, a: 0.02 });
    noise(c, o, t, { dur: 0.3, vol: 0.06 * v, type: 'lowpass', f0: 600, f1: 120, a: 0.02 });
  },
  soft: (c, o, t, p) => tone(c, o, t, { type: 'sine', f0: p.freq ?? 880, dur: 0.14, vol: 0.05 * (p.volume ?? 1), a: 0.008 }),
  chime: (c, o, t, p) => { // gentle two-note resolve
    const v = p.volume ?? 1;
    [[659.25, 0], [987.77, 0.09]].forEach(([f, d]) => tone(c, o, t + d, { type: 'sine', f0: f, dur: 0.9, vol: 0.06 * v, a: 0.01 }));
  },
  blip: (c, o, t, p) => tone(c, o, t, { type: 'square', f0: p.freq ?? 660, dur: 0.06, vol: 0.08 * (p.volume ?? 1) }),
};

export const registerSfx = (name, fn) => { SFX[name] = fn; };

// Minimal ambient pad (for when no music file is supplied).
export function pad(c, o, t, { dur = 10, volume = 1, root = 220 } = {}) {
  [1, 1.25, 1.5, 2].forEach((m, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = root * m;
    osc.detune.value = (i - 1.5) * 6;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.04 * volume, t + 2);
    g.gain.setValueAtTime(0.04 * volume, t + Math.max(2, dur - 2));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(o);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  });
}
registerSfx('pad', pad);

const bufCache = new Map();
async function loadBuffer(ctx, src) {
  if (!bufCache.has(src)) {
    bufCache.set(src, fetch(src).then((r) => {
      if (!r.ok) throw new Error(`audio ${src}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }));
  }
  return ctx.decodeAudioData((await bufCache.get(src)).slice(0));
}

// Schedule every cue with timeline time >= from, relative to ctx time `ctxStart`.
export async function scheduleCues(ctx, dest, cues, from, ctxStart) {
  for (const cue of cues) {
    if (cue.type === 'sfx') {
      if (cue.t < from - 0.01) continue;
      const fn = SFX[cue.name];
      if (!fn) { console.warn(`unknown sfx "${cue.name}"`); continue; }
      fn(ctx, dest, ctxStart + (cue.t - from), cue.opts);
    } else {
      const o = cue.opts;
      let buf;
      try { buf = await loadBuffer(ctx, cue.src); } catch (e) { console.warn(e.message); continue; }
      const len = o.dur ?? buf.duration - (o.offset || 0);
      const endT = cue.t + len;
      if (endT <= from) continue;
      const skip = Math.max(0, from - cue.t);
      const when = ctxStart + Math.max(0, cue.t - from);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !!o.loop;
      const g = ctx.createGain();
      const vol = o.volume ?? 1;
      const fi = o.fadeIn || 0, fo = o.fadeOut || 0;
      g.gain.setValueAtTime(fi && skip < fi ? vol * (skip / fi) : vol, when);
      if (fi && skip < fi) g.gain.linearRampToValueAtTime(vol, when + fi - skip);
      if (fo) {
        g.gain.setValueAtTime(vol, when + Math.max(0, len - skip - fo));
        g.gain.linearRampToValueAtTime(0.0001, when + len - skip);
      }
      src.connect(g).connect(dest);
      src.start(when, (o.offset || 0) + (o.loop ? skip % buf.duration : skip));
      src.stop(when + len - skip);
    }
  }
}

// Master bus shared by live + offline: gentle room reverb, low-pass, glue compressor.
// Keeps procedural hits from sounding clipped or "dry". opts.bus = false to bypass.
export function masterBus(ctx, out, { reverb = 0.18, tone = 11000, bypass = false } = {}) {
  if (bypass) return out;
  const input = ctx.createGain();
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = tone; lp.Q.value = 0.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.006; comp.release.value = 0.22;
  const trim = ctx.createGain(); trim.gain.value = 0.9;
  input.connect(lp); lp.connect(comp);
  if (reverb > 0) {
    const len = Math.floor(ctx.sampleRate * 1.6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let r = 9876 + c * 31;
      for (let i = 0; i < len; i++) { r = (r * 1103515245 + 12345) >>> 0; d[i] = ((r / 4294967296) * 2 - 1) * Math.pow(1 - i / len, 3); }
    }
    const cv = ctx.createConvolver(); cv.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = reverb;
    lp.connect(cv).connect(wet).connect(comp);
  }
  comp.connect(trim).connect(out);
  return input;
}

export async function renderOffline(cues, duration, sampleRate = 48000, bus) {
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  await scheduleCues(ctx, masterBus(ctx, master, bus), cues, 0, 0);
  return toWav(await ctx.startRendering());
}

function toWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let p = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

// ---------------------------------------------------------------- audio analysis (TouchDesigner Audio Analysis CHOP)
// Pre-computes a loudness envelope per frame so audio-reactive motion stays a pure function of time.
//   await analyzeAudio('assets/music.mp3', { name: 'music', fps: 60, bands: { low: [20, 200], high: [2000, 8000] } })
//   → graph: { fx: [{ type: 'envelope', name: 'music', band: 'low', amp: 1 }] } or expr: 'env("music.low")'
export async function analyzeAudio(src, { name = src, fps = 60, bands = {}, smooth = 0.6 } = {}) {
  const probe = new OfflineAudioContext(1, 1, 48000);
  const buf = await loadBuffer(probe, src);
  const one = async (lo, hi) => {
    const ctx = new OfflineAudioContext(1, buf.length, buf.sampleRate);
    const s = ctx.createBufferSource(); s.buffer = buf;
    let node = s;
    if (lo != null) {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = hi;
      node = node.connect(hp).connect(lp);
    }
    node.connect(ctx.destination); s.start();
    const d = (await ctx.startRendering()).getChannelData(0), hop = buf.sampleRate / fps, n = Math.ceil(d.length / hop);
    const out = new Float32Array(n);
    let peak = 1e-9, prev = 0;
    for (let f = 0; f < n; f++) {
      let sum = 0; const a = Math.floor(f * hop), b = Math.min(d.length, Math.floor((f + 1) * hop));
      for (let i = a; i < b; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / Math.max(1, b - a));
      out[f] = prev = rms > prev ? rms : prev * smooth + rms * (1 - smooth); // fast attack, smoothed release
      peak = Math.max(peak, out[f]);
    }
    for (let f = 0; f < n; f++) out[f] /= peak; // normalized 0..1
    return out;
  };
  registerEnvelope(name, await one(), fps);
  for (const [k, [lo, hi]] of Object.entries(bands)) registerEnvelope(`${name}.${k}`, await one(lo, hi), fps);
  return ENVELOPES[name];
}
