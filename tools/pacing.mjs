// 节奏探针：量「每一镜演完之后，画面还空等了多久」。
//
// 只输出读数，不判对错：教程里演完空等 5s 通常是拖沓，MV 里同样的 5s 可能是故意的留白。
// --limit / --end-hold 只决定表里哪些行打 ✗ 标记，不影响 exit code。
//
// 做法：逐帧 seek，量每个元素的「几何 + 透明度」，用**章节局部坐标**（元素 rect 减去所属 panel
// 的 rect）抵消镜头平移，所以相机运动不会被误判成内容运动；再用阈值滤掉呼吸之类的环境运动。
// 光标在屏幕固定层，单独按时间归因到它所在的那一章。
//
//   node tools/pacing.mjs projects/<name>                  # 标记阈值 0.5s，末幕 3s
//   node tools/pacing.mjs projects/<name> --limit 0.4 --end-hold 2 --step 0.05
//   node tools/pacing.mjs projects/<name> --quiet          # 只看结论
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve, ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  else pos.push(argv[i]);
}
const project = pos[0];
if (!project) { console.error('usage: node tools/pacing.mjs <project> [--limit 0.5] [--end-hold 3] [--step 0.05]'); process.exit(2); }

const LIMIT = opt.limit === undefined ? 0.5 : +opt.limit;
const END_HOLD = opt['end-hold'] === undefined ? 3.0 : +opt['end-hold'];
const STEP = opt.step === undefined ? 0.05 : +opt.step;
// 阈值：角色呼吸这类环境运动约 1px/0.1s，滤掉；真正的入场位移是几十像素
const MOVE = 1.5, FADE = 0.02;

const projDir = path.resolve(project);
const rel = path.relative(ROOT, projDir).split(path.sep).join('/');
const port = 5300 + Math.floor(Math.random() * 500);
const server = await serve(port);
const chrome = opt.chrome || process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('找不到 Chrome/Edge，设 CHROME_PATH'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--hide-scrollbars'] });
let bad = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/${rel}/?export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__videoReady === true', { timeout: 60000 });
  const info = await page.evaluate(() => ({
    d: __video.duration,
    chapters: (__video.chapters || []).map((c) => ({ id: c.id, start: c.start, end: c.end })),
  }));
  if (!info.chapters.length) { console.error('这个项目没有 chapters（场景模式暂不支持）'); process.exit(2); }

  const built = await page.evaluate((move, fade) => {
    window.__probe = { move, fade, els: [], prev: [], last: {}, lastEl: {}, cursorTimes: [] };
    const p = window.__probe;
    for (const el of document.querySelectorAll('.panel.chapter *, .film-cursor')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'i') continue; // 纯装饰
      p.els.push(el);
    }
    p.prev = new Array(p.els.length).fill(null);
    return { n: p.els.length, nCursor: p.els.filter((e) => e.classList.contains('film-cursor')).length };
  }, MOVE, FADE);
  if (!built.nCursor) console.log('提示：没找到 .film-cursor（本片没用光标主线），只量章节内容。');

  for (let t = 0; t <= info.d + 1e-6; t += STEP) {
    const tt = +t.toFixed(3);
    await page.evaluate((x) => __video.seek(x), tt);
    await page.evaluate((x) => {
      const p = window.__probe;
      for (let i = 0; i < p.els.length; i++) {
        const el = p.els[i];
        const r = el.getBoundingClientRect();
        const panel = el.closest('.panel.chapter');
        const pr = panel ? panel.getBoundingClientRect() : null;
        const cur = [pr ? r.left - pr.left : r.left, pr ? r.top - pr.top : r.top, r.width, r.height,
          parseFloat(getComputedStyle(el).opacity || '1')];
        const pv = p.prev[i];
        if (pv) {
          const moved = Math.max(Math.abs(cur[0] - pv[0]), Math.abs(cur[1] - pv[1]), Math.abs(cur[2] - pv[2]), Math.abs(cur[3] - pv[3]));
          if (moved > p.move || Math.abs(cur[4] - pv[4]) > p.fade) {
            const key = panel ? panel.dataset.chapter : 'cursor';
            p.last[key] = x;
            p.lastEl[key] = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '');
            if (!panel) p.cursorTimes.push(x);
          }
        }
        p.prev[i] = cur;
      }
    }, tt);
  }

  const { last, lastEl, cursorTimes } = await page.evaluate(() => ({ last: window.__probe.last, lastEl: window.__probe.lastEl, cursorTimes: window.__probe.cursorTimes }));

  const rows = [];
  for (let i = 0; i < info.chapters.length; i++) {
    const c = info.chapters[i];
    const content = last[c.id] ?? 0;
    const inWin = cursorTimes.filter((t) => t >= c.start && t <= c.end);
    const cursor = inWin.length ? Math.max(...inWin) : 0;
    const t = Math.max(content, cursor);
    const cap = i === info.chapters.length - 1 ? END_HOLD : LIMIT; // 末幕允许刻意留长
    rows.push({ ...c, t, gap: c.end - t, from: cursor > content ? '光标' : (lastEl[c.id] || '章节内容'), cap });
    if (c.end - t > cap + 1e-6) bad++;
  }

  if (!opt.quiet) {
    console.log(`\n项目 ${rel}   ${info.d.toFixed(1)}s   采样 ${STEP}s   标记阈值 ${LIMIT}s（末幕 ${END_HOLD}s）\n`);
    console.log('章节                    章末    最后一拍    间隔    阈值   来源');
    for (const r of rows) {
      const mark = r.gap > r.cap + 1e-6 ? '✗' : '✓';
      console.log(`${(r.id + ' ' + r.start.toFixed(1) + '–' + r.end.toFixed(1) + 's').padEnd(22)} ${r.end.toFixed(2).padStart(6)} ${r.t.toFixed(2).padStart(9)} ${r.gap.toFixed(2).padStart(7)}s ${r.cap.toFixed(1).padStart(6)}   ${r.from} ${mark}`);
    }
  }
  const worst = Math.max(...rows.map((r) => r.gap));
  console.log(bad
    ? `\n读数：${bad} 章演完后空等超过标记阈值（最长 ${worst.toFixed(2)}s）。是不是拖沓，按这一支片子的原则判断。`
    : `\n读数：每章最后一拍都在标记阈值内（最长 ${worst.toFixed(2)}s）。`);
} finally {
  await browser.close();
  server.close();
}
process.exit(0);
