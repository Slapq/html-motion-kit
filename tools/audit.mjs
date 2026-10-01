#!/usr/bin/env node
// 版面审计：一次无头浏览器里把时间轴扫一遍，用数字报出几何问题——
// 文字被裁、内容出画、文字互相压叠、空帧、页面报错、镜头跳变。
// 比逐帧截图快两个数量级，也不靠肉眼。
//
//   node tools/audit.mjs projects/tech-promo [--step 0.2] [--from 0] [--to 24] [--quiet]
//        [--still 1.5]      画面连续 N 秒几乎不变 → 报「静止」（0 = 关闭）
//        [--still-diff 0.4] 与该段起始帧的平均像素差阈值（0–255 灰度）
//        [--max-px 80]      镜头单帧位移上限（按 fps 换算）
//        [--sparse 0.8]     可见内容文字 <3 块持续 N 秒 → 报「偏空」
//        [--contrast 0.5]   每 N 秒查一次文字对比度（WCAG AA：正文 4.5、大字 3；0 = 关闭）
//        [--no-hints]       不打印「提示」级条目
//
// 分级：只有「裁切」「出画」和页面报错算阻塞（exit code 1）——它们是客观上坏掉了。
// 其余（压叠、空帧/偏空、静止、对比度、镜头速度、rhythm、交接、色号/字号）都是「读数」：
// 告诉你画面里发生了什么，要不要改由这一支片子的原则决定，不影响 exit code。
// 只量 DOM 文字；全部画在 canvas 上的片子，空帧/偏空读数没有意义。
import path from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { serve, ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const project = argv.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
if (!project) { console.error('usage: node tools/audit.mjs projects/<name> [--step 0.2]'); process.exit(2); }

const CHROMES = [
  process.env.CHROME_PATH, opt.chrome,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found; set CHROME_PATH'); process.exit(2); }

// ---- in-page probe: one seek, then measure everything -----------------------
const PROBE = (t) => {
  const stage = document.querySelector('.stage');
  const W = stage.clientWidth, H = stage.clientHeight;
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= parseFloat(cs.opacity || '1');
      if (o < 0.02) return 0;
    }
    return o;
  };
  const sig = (el) => {
    const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + cls;
  };
  const strip = document.querySelector('.strip');
  const camX = strip ? Math.round(strip.getBoundingClientRect().left) : 0;
  // 镜头停稳：偏移接近 1920 的整数倍（容差 10px）
  const off = ((camX % 1920) + 1920) % 1920;
  const atRest = off < 10 || off > 1910;

  const leaves = [];
  const clipped = [];
  const range = document.createRange();
  for (const el of document.querySelectorAll('.scene *, .hud *, .carry-layer *, .captions')) {
    if (el.children.length) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    // 文字溢出自己的盒子（被裁）
    const cw = el.clientWidth, ch = el.clientHeight;
    if (cw > 0 && (el.scrollWidth > cw + 1 || el.scrollHeight > ch + 1)) {
      clipped.push({ el: sig(el), txt: txt.slice(0, 22), box: [cw, ch], want: [el.scrollWidth, el.scrollHeight] });
    }
    const o = opacityOf(el);
    if (o < 0.4) continue;
    // 量文字墨迹范围，而不是盒子——居中标题的盒子本来就可能满宽
    range.selectNodeContents(el);
    const rr = range.getBoundingClientRect();
    const r = rr.width > 0 && rr.height > 0 ? rr : el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right <= 0 || r.left >= W || r.bottom <= 0 || r.top >= H) continue;
    leaves.push({ el: sig(el), txt: txt.slice(0, 22), r, o, hud: !!el.closest('.hud'), fly: el.closest('.carry-box') });
  }
  // 空帧/偏空只数内容文字：进度轴刻度标签常驻画面，不算"有内容"
  const content = leaves.filter((l) => !l.hud).length;

  const offstage = atRest ? leaves
    .filter((l) => l.r.left < -2 || l.r.right > W + 2 || l.r.top < -2 || l.r.bottom > H + 2)
    .map((l) => ({ el: l.el, txt: l.txt, x: [Math.round(l.r.left), Math.round(l.r.right)] })) : [];

  const overlap = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      // 同一次 carry 飞行里的两份快照本来就叠在一起交叉淡化
      if (leaves[i].fly && leaves[i].fly === leaves[j].fly) continue;
      const a = leaves[i].r, b = leaves[j].r;
      if (a.width * a.height < 400 || b.width * b.height < 400) continue;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix <= 0 || iy <= 0) continue;
      const inter = ix * iy;
      const small = Math.min(a.width * a.height, b.width * b.height);
      if (inter / small > 0.12) {
        overlap.push({ a: leaves[i].el, b: leaves[j].el, pct: Math.round((inter / small) * 100) });
      }
    }
  }
  const cur = document.querySelector('.film-cursor');
  const cursorOn = !!cur && parseFloat(getComputedStyle(cur).opacity) > 0.5;
  return { t, camX, atRest, n: content, clipped, offstage, overlap, cursorOn };
};

// ---- contrast: collect settled text, then hide all text so the next screenshot is pure background
const CPROBE = () => {
  const stage = document.querySelector('.stage');
  const W = stage.clientWidth, H = stage.clientHeight;
  const out = [];
  const range = document.createRange();
  for (const el of document.querySelectorAll('.scene *, .hud *, .carry-layer *, .captions')) {
    if (el.children.length) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (c.visibility === 'hidden' || c.display === 'none') { o = 0; break; }
      o *= parseFloat(c.opacity || '1');
    }
    // 只查入场完成的文字：淡入淡出途中本来就低对比
    if (o < 0.95) continue;
    const fill = cs.webkitTextFillColor || cs.color;
    const m = fill.match(/rgba?\(([^)]+)\)/);
    if (!m) continue;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (a < 0.05) continue; // 渐变字（background-clip:text）量不了，跳过
    range.selectNodeContents(el);
    const rr = range.getBoundingClientRect();
    if (rr.width < 4 || rr.height < 4) continue;
    if (rr.right <= 0 || rr.left >= W || rr.bottom <= 0 || rr.top >= H) continue;
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
    out.push({
      el: el.tagName.toLowerCase() + cls, txt: txt.slice(0, 22), rgb: [r, g, b], a: a * o,
      box: [Math.max(0, rr.left), Math.max(0, rr.top), Math.min(W, rr.right), Math.min(H, rr.bottom)],
      // WCAG 大字：≥24px，或 ≥18.66px 且粗体
      need: size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5, size: Math.round(size), hud: !!el.closest('.hud'),
    });
  }
  const st = document.createElement('style');
  st.id = '__audit_hide';
  st.textContent = '.scene *, .hud *, .carry-layer *, .captions { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }';
  document.head.appendChild(st);
  return out;
};
const CONTRAST = async (b64, items, k) => {
  document.getElementById('__audit_hide')?.remove();
  const im = new Image();
  im.src = 'data:image/png;base64,' + b64;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
  const bad = [];
  for (const it of items) {
    const x0 = Math.floor(it.box[0] * k), y0 = Math.floor(it.box[1] * k);
    const w = Math.max(1, Math.ceil(it.box[2] * k) - x0), h = Math.max(1, Math.ceil(it.box[3] * k) - y0);
    const d = g.getImageData(x0, y0, w, h).data;
    let r = 0, gg = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const bg = [r / n, gg / n, b / n];
    // 半透明文字按实际混合后的颜色算
    const fg = it.rgb.map((v, i) => v * it.a + bg[i] * (1 - it.a));
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < it.need) bad.push({ el: it.el, txt: it.txt, ratio: +ratio.toFixed(2), need: it.need });
  }
  return bad;
};

// ---- run --------------------------------------------------------------------
const projDir = path.resolve(project);
const rel = path.relative(ROOT, projDir).split(path.sep).join('/');
const port = 5300 + Math.floor(Math.random() * 500);
const server = await serve(port);
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
const errors = [];
// 缩略图 → 灰度数组（在页面里解码，不需要额外依赖）
const GRAY = async (b64) => {
  const im = new Image();
  im.src = 'data:image/png;base64,' + b64;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, out = new Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return out;
};
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

const issues = []; // 检测到的条目（裁切/出画阻塞，其余为读数）
const hints = [];  // 风格读数
let summary = {};
try {
  await page.goto(`http://127.0.0.1:${port}/${rel}/?export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__videoReady === true', { timeout: 60000 });
  const vp = await page.evaluate(() => ({ w: __video.width, h: __video.height }));
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
  const info = await page.evaluate(() => ({
    w: __video.width, h: __video.height, d: __video.duration, fps: __video.fps, hasAudio: __video.hasAudio,
    units: (__video.chapters || []).map((c) => ({ id: c.id, start: c.start, end: c.end, rhythm: c.rhythm || null })),
    carry: __video.timeline?.carry ? JSON.parse(JSON.stringify(__video.timeline.carry)) : null,
  }));
  // 节奏标签：t 落在哪个单元（场景模式转场期重叠，取后开始的那个）
  const RHYTHMS = ['anchor', 'dense', 'breathing'];
  const unitAt = (t) => { let u = null; for (const x of info.units) if (t >= x.start - 1e-6 && t < x.end) u = x; return u; };
  const breathingAt = (t) => unitAt(t)?.rhythm === 'breathing';
  {
    const U = info.units;
    for (const u of U) if (u.rhythm && !RHYTHMS.includes(u.rhythm)) issues.push(`${u.start.toFixed(2)}s  节奏    ${u.id} 的 rhythm "${u.rhythm}" 未知（可用：${RHYTHMS.join(' / ')}）`);
    const bt = U.filter((u) => u.rhythm === 'breathing').reduce((a, u) => a + (u.end - u.start), 0);
    if (bt > info.d * 0.3 + 1e-6) issues.push(`0.00s  节奏    breathing 合计 ${bt.toFixed(1)}s，占全片 ${Math.round((bt / info.d) * 100)}%`);
    for (let i = 1; i < U.length; i++) if (U[i].rhythm === 'breathing' && U[i - 1].rhythm === 'breathing') issues.push(`${U[i].start.toFixed(2)}s  节奏    ${U[i - 1].id} 与 ${U[i].id} 连续两段 breathing`);
  }
  const step = +(opt.step || 0.2);
  const from = +(opt.from || 0), to = +(opt.to || info.d);
  // 片头/片尾的淡入淡出允许没有内容
  const grace = opt.grace === undefined ? 0.35 : +opt.grace;
  const graceEnd = opt['grace-end'] === undefined ? 1.0 : +opt['grace-end'];

  const stillSec = opt.still === undefined ? 1.5 : +opt.still;
  const stillDiff = opt['still-diff'] === undefined ? 0.4 : +opt['still-diff'];
  const stills = [];
  let prevGray = null, anchorT = 0, stillFrom = null, maxDiffIn = 0;
  const closeStill = (tEnd) => {
    if (stillFrom !== null && tEnd - stillFrom >= stillSec - 1e-6) stills.push([stillFrom, tEnd]);
    stillFrom = null;
  };
  const sparseSec = opt.sparse === undefined ? 0.8 : +opt.sparse;
  let sparseFrom = null, sparseMin = Infinity;
  const closeSparse = (tEnd) => {
    if (sparseFrom !== null && tEnd - sparseFrom + step >= sparseSec - 1e-6) issues.push(`${sparseFrom.toFixed(2)}s  偏空    ${sparseFrom.toFixed(2)}–${tEnd.toFixed(2)}s 最少只有 ${sparseMin} 个可见文字块`);
    sparseFrom = null; sparseMin = Infinity;
  };
  const rows = [];
  let prevCam = null, maxJump = 0, jumpAt = 0;
  // 对比度：每 --contrast 秒查一次（0 = 关闭）。同一文字块只报一次，带最低值和出现次数
  const cEvery = opt.contrast === undefined ? 0.5 : +opt.contrast;
  let nextC = from;
  const lowC = new Map();
  const palette = new Map(), sizes = new Map(); // 色号 / 字号 → 首个出现的文字块
  for (let t = from; t <= to + 1e-6; t += step) {
    const tt = +t.toFixed(3);
    await page.evaluate((x) => __video.seek(x), tt);
    const r = await page.evaluate(PROBE, tt);
    rows.push(r);
    summary = { w: info.w, h: info.h, d: info.d, fps: info.fps, hasAudio: info.hasAudio };
    if (prevCam !== null && Math.abs(r.camX - prevCam) > maxJump) { maxJump = Math.abs(r.camX - prevCam); jumpAt = tt; }
    prevCam = r.camX;
    if (stillSec > 0) {
      const b64 = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: info.w, height: info.h, scale: 0.1 } });
      const gray = await page.evaluate(GRAY, b64);
      // 与本段起点（锚帧）比较，而不是与上一采样比较：缓慢但持续的漂移在小步长下
      // 相邻差很小，却不是静止。锚帧比较让结论与 --step 无关。
      if (prevGray) {
        let sum = 0;
        for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevGray[i]);
        const diff = sum / gray.length;
        if (diff < stillDiff) { if (stillFrom === null) stillFrom = anchorT; maxDiffIn = Math.max(maxDiffIn, diff); }
        else { closeStill(+(tt - step).toFixed(3)); prevGray = gray; anchorT = tt; }
      } else { prevGray = gray; anchorT = tt; }
    }
    if (cEvery > 0 && tt + 1e-6 >= nextC) {
      nextC = tt + cEvery;
      const items = await page.evaluate(CPROBE);
      for (const it of items) {
        if (it.hud) continue;
        const key = it.rgb.map((v) => Math.round(v / 8)).join(',');
        if (!palette.has(key)) palette.set(key, it.txt);
        if (!sizes.has(it.size)) sizes.set(it.size, it.txt);
      }
      const k = 0.25;
      const b64 = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: info.w, height: info.h, scale: k } });
      const bad = await page.evaluate(CONTRAST, b64, items, k);
      for (const c of bad) {
        const key = c.el + '|' + c.txt;
        const prev = lowC.get(key);
        if (!prev) lowC.set(key, { ...c, t: tt, n: 1 });
        else { prev.n++; if (c.ratio < prev.ratio) prev.ratio = c.ratio; }
      }
    }
    for (const c of r.clipped) issues.push(`${tt.toFixed(2)}s  裁切    ${c.el}  "${c.txt}"  ${c.box} → 需要 ${c.want}`);
    for (const c of r.offstage) issues.push(`${tt.toFixed(2)}s  出画    ${c.el}  "${c.txt}"  x ${c.x[0]}..${c.x[1]}`);
    for (const c of r.overlap) issues.push(`${tt.toFixed(2)}s  压叠    ${c.a} ✕ ${c.b}  重叠 ${c.pct}%`);
    if (r.n === 0) { if (tt > +from + grace && tt < to - graceEnd) issues.push(`${tt.toFixed(2)}s  空帧    画面内没有任何可见文字`); }
    // 偏空：入场错落时一两个块先出现是正常的，只有持续 ≥ --sparse 秒才报
    if (r.n > 0 && r.n < 3 && tt > +from + grace && tt < to - graceEnd && !breathingAt(tt)) { if (sparseFrom === null) sparseFrom = tt; sparseMin = Math.min(sparseMin, r.n); }
    else closeSparse(+(tt - step).toFixed(3));
  }

  closeSparse(+to.toFixed(3));
  if (stillSec > 0) closeStill(+to.toFixed(3));
  for (const [a, b] of stills) {
    if (b <= from + grace || a >= to - graceEnd) continue;
    // breathing 段：内容停住是设计，放宽到 2 倍时长
    if (breathingAt(a) && breathingAt(b - 1e-3) && b - a < stillSec * 2) continue;
    issues.push(`${a.toFixed(2)}s  静止    ${a.toFixed(2)}–${b.toFixed(2)}s 共 ${(b - a).toFixed(1)}s 画面几乎不变（阈值 ${stillDiff}）`);
  }
  for (const c of lowC.values()) {
    issues.push(`${c.t.toFixed(2)}s  对比度  ${c.el}  "${c.txt}"  最低 ${c.ratio}:1（需要 ${c.need}:1，${c.n} 次采样不达标）——加深文字色或给背景加底`);
  }
  // ---- 提示级：不影响 exit code ----
  if (info.carry) {
    const on = (t0, t1) => rows.some((r) => r.cursorOn && r.t >= t0 && r.t <= t1);
    for (const b of info.carry.boundaries) {
      if (b.carries.length || on(b.at - 0.4, b.at + 0.4)) continue;
      hints.push(`${b.at.toFixed(2)}s  交接    ${b.from} → ${b.to} 没有任何东西延续——给两边同一元素加 data-carry="名字"，或让 ctx.cursor 带过去`);
    }
  }
  for (const u of info.units.filter((x) => x.rhythm === 'dense')) {
    const seg = rows.filter((r) => r.t >= u.start && r.t < u.end);
    const avg = seg.reduce((a, r) => a + r.n, 0) / Math.max(1, seg.length);
    if (seg.length && avg < 4) hints.push(`${u.start.toFixed(2)}s  节奏    dense 段 ${u.id} 平均只有 ${avg.toFixed(1)} 个文字块——内容不够密，考虑改成 anchor`);
  }
  if (palette.size > 6) hints.push(`0.00s  色号    文字用了 ${palette.size} 种颜色（建议 ≤6）——收拢到 :root 的 --fg/--muted/--accent 等变量`);
  if (sizes.size > 7) hints.push(`0.00s  字号    文字用了 ${sizes.size} 种字号（${[...sizes.keys()].sort((a, b) => a - b).join('/')}px，建议 ≤7）——收拢到 .h1/.h2/.lede/.sub 这几级`);

  const maxPx = opt['max-px'] === undefined ? 80 : +opt['max-px'];
  // 镜头：单步位移（换算成 px/s）与整体单调性
  const cams = rows.map((r) => r.camX);
  const backwards = rows.filter((r, i) => i && r.camX > rows[i - 1].camX + 1);
  const speed = maxJump / step;
  const perFrame = speed / info.fps;
  if (perFrame > maxPx * 1.05) issues.push(`${jumpAt.toFixed(2)}s  镜头    约 ${perFrame.toFixed(0)}px/帧（参考值 ${maxPx}）`);

  console.log(`\n项目 ${rel}   ${summary.w}×${summary.h}  ${summary.d}s  ${summary.fps}fps  音频 ${summary.hasAudio ? '有' : '无'}`);
  console.log(`采样 ${rows.length} 点（每 ${step}s）\n`);

  if (errors.length) { console.log('页面错误：'); for (const e of errors.slice(0, 10)) console.log('  ' + e); console.log(''); }
  const BLOCK = /^S+s+(裁切|出画)s/;
  const blocking = issues.filter((s) => BLOCK.test(s)), readings = issues.filter((s) => !BLOCK.test(s));
  const MAX = +(opt.max || 40);
  if (blocking.length) {
    console.log(`问题 ${blocking.length} 条（阻塞：文字被裁或出画）：`);
    for (const s of blocking.slice(0, MAX)) console.log('  ' + s);
    if (blocking.length > MAX) console.log(`  … 其余 ${blocking.length - MAX} 条省略`);
  } else {
    console.log('问题 0 条：无裁切、无出画。');
  }
  if (readings.length) {
    console.log(`
读数 ${readings.length} 条（不阻塞，按这一支片子的原则判断）：`);
    for (const s of readings.slice(0, MAX)) console.log('  ' + s);
    if (readings.length > MAX) console.log(`  … 其余 ${readings.length - MAX} 条省略`);
  }
  if (hints.length && !opt['no-hints']) {
    console.log(`
风格读数 ${hints.length} 条（不阻塞）：`);
    for (const s of hints.slice(0, 20)) console.log('  ' + s);
  }

  // 每 0.5s 的文字密度，一眼看出哪段画面太空
  if (!opt.quiet) {
    const bins = [];
    for (let i = 0; i < rows.length; i += Math.max(1, Math.round(0.5 / step))) {
      const seg = rows.slice(i, i + Math.max(1, Math.round(0.5 / step)));
      bins.push(seg.reduce((a, r) => a + r.n, 0) / seg.length);
    }
    const peak = Math.max(1, ...bins);
    console.log('\n文字密度（每格 0.5s，■ = 该段可见文字块数）：');
    console.log('  ' + bins.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / peak) * 7))]).join(''));
  }
  console.log(`\n镜头：最大单步位移 ${maxJump}px/${step}s（${speed.toFixed(0)}px/s ≈ ${perFrame.toFixed(0)}px/帧，t=${jumpAt}s）  回退 ${backwards.length} 次`);
  if (stillSec > 0) console.log(`静止：${stills.length ? stills.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}s`).join('，') : `无（没有 ≥${stillSec}s 且帧差 <${stillDiff} 的段落）`}`);
  const blank = readings.filter((s) => /空帧|偏空/.test(s)).length;
  if (info.carry) console.log(`交接：${info.carry.boundaries.length} 处，carry 飞行 ${info.carry.flights.length} 次${info.carry.cursor ? '，全片光标已启用' : ''}`);
  console.log(`结论：${errors.length ? '有页面错误' : '无页面错误'} · ${blocking.length} 条阻塞问题 · ${readings.length} 条读数（其中空/偏空 ${blank}） · ${hints.length} 条风格读数`);
  if (errors.length || blocking.length) process.exitCode = 1;
} catch (e) {
  console.error('audit failed:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
