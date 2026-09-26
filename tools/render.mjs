#!/usr/bin/env node
// Frame-exact MP4 export: headless Chrome seeks the timeline frame by frame,
// screenshots are piped to ffmpeg, procedural/file audio is rendered offline.
//
//   node tools/render.mjs projects/demo [--out out.mp4] [--fps 30] [--from 0] [--to 10]
//        [--scale 1] [--crf 18] [--chrome "C:/.../chrome.exe"] [--still 3.5 --out frame.png]
//        [--props props.json]   input props (Remotion-style): same page, different data
//        [--workers 4]          parallel chunked render (Remotion-style), segments concatenated losslessly
//        [--inspect trace.json] write the full tl.inspect() trace next to the video
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { serve, ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const project = argv.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
const opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
if (!project) { console.error('usage: node tools/render.mjs projects/<name> [--out file.mp4]'); process.exit(2); }

const CHROMES = [
  process.env.CHROME_PATH, opt.chrome,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; pass --chrome or set CHROME_PATH'); process.exit(2); }

const projDir = path.resolve(project);
const rel = path.relative(ROOT, projDir).split(path.sep).join('/');
const port = 5300 + Math.floor(Math.random() * 500);
const server = await serve(port);
// One browser per worker: pages of a single headless browser share one compositor, and screenshots of
// non-front tabs can stall (Runtime.callFunctionOn timeout), so --workers uses isolated processes.
const launch = () => puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const browsers = [await launch()];
const cleanup = async () => { await Promise.all(browsers.map((b) => b.close().catch(() => {}))); server.close(); };

const props = opt.props ? JSON.parse(await fs.readFile(path.resolve(opt.props), 'utf8')) : null;
const url = `http://127.0.0.1:${port}/${rel}/?export`;
async function openPage(browser = browsers[0]) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (['error', 'warn'].includes(m.type()) && !/Failed to load resource/.test(m.text())) console.log(`[page ${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  if (props) await page.evaluateOnNewDocument((p) => { window.__props = p; }, props);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__videoReady === true', { timeout: 60000 });
  return page;
}
const run = (args) => new Promise((res, rej) => {
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});
// Render frames [i0, i1) of the timeline to a video-only mp4.
async function renderChunk(page, info, fps, from, i0, i1, out, scale, progress) {
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opt.crf || 18), '-pix_fmt', 'yuv420p',
    '-vf', `scale=${info.w * scale}:${info.h * scale}`, out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  done.catch(() => {});
  ff.stdin.on('error', () => {});
  try {
  for (let i = i0; i < i1; i++) {
    await page.evaluate((t) => __video.seek(t), from + i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95, optimizeForSpeed: true });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    progress();
  }
  } catch (e) { ff.kill(); throw e; }
  ff.stdin.end();
  await done;
}

try {
  const page = await openPage();
  const info = await page.evaluate(() => ({ w: __video.width, h: __video.height, fps: __video.fps, d: __video.duration, hasAudio: __video.hasAudio }));
  const scale = +(opt.scale || 1);
  await page.setViewport({ width: info.w, height: info.h, deviceScaleFactor: scale });
  if (opt.inspect) {
    await fs.writeFile(path.resolve(opt.inspect), JSON.stringify(await page.evaluate(() => __video.inspect()), null, 2));
    console.log(`✓ trace ${opt.inspect}`);
  }

  if (opt.still !== undefined) {
    const t = +opt.still;
    await page.evaluate((t) => __video.seek(t), t);
    const out = opt.out || path.join(projDir, `still-${t}.png`);
    await page.screenshot({ path: out, type: 'png' });
    console.log(`✓ ${out}`);
  } else {
    const fps = +(opt.fps || info.fps);
    const from = +(opt.from || 0), to = Math.min(+(opt.to || info.d), info.d);
    const frames = Math.round((to - from) * fps);
    const out = path.resolve(opt.out || path.join(projDir, 'out.mp4'));
    const workers = Math.max(1, Math.min(+(opt.workers || 1), os.cpus().length, Math.ceil(frames / fps)));
    let wav = null;
    if (info.hasAudio && !opt.mute) {
      const b64 = await page.evaluate(() => __video.audioWav());
      wav = out.replace(/\.mp4$/i, '') + '.audio.wav';
      await fs.writeFile(wav, Buffer.from(b64, 'base64'));
    }
    const t0 = Date.now();
    let doneFrames = 0;
    const progress = () => {
      if (++doneFrames % fps === 0) process.stdout.write(`\r  frame ${doneFrames}/${frames}  ${((doneFrames / frames) * 100).toFixed(0)}%  ${((Date.now() - t0) / 1000).toFixed(0)}s  ×${workers}`);
    };
    const base = out.replace(/\.mp4$/i, '');
    const segs = Array.from({ length: workers }, (_, k) => `${base}.part${k}.mp4`);
    const bounds = segs.map((_, k) => [Math.round((frames * k) / workers), Math.round((frames * (k + 1)) / workers)]);
    const pages = [page, ...(await Promise.all(segs.slice(1).map(async () => {
      const b = await launch(); browsers.push(b);
      const p = await openPage(b); await p.setViewport({ width: info.w, height: info.h, deviceScaleFactor: scale }); return p;
    })))];
    try {
      await Promise.all(segs.map((seg, k) => renderChunk(pages[k], info, fps, from, bounds[k][0], bounds[k][1], seg, scale, progress)));
      const list = `${base}.parts.txt`;
      await fs.writeFile(list, segs.map((f) => `file '${path.basename(f)}'`).join('\n'));
      await run([
        '-f', 'concat', '-safe', '0', '-i', list,
        ...(wav ? ['-ss', String(from), '-t', String(to - from), '-i', wav] : []),
        '-c:v', 'copy', ...(wav ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
        '-movflags', '+faststart', out,
      ]);
      await fs.unlink(list).catch(() => {});
    } finally {
      for (const f of segs) await fs.unlink(f).catch(() => {});
      if (wav) await fs.unlink(wav).catch(() => {});
    }
    console.log(`\n✓ ${out}  (${frames} frames, ${(to - from).toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(0)}s render, ${workers} worker${workers > 1 ? 's' : ''})`);
  }
} catch (e) {
  console.error('render failed:', e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
