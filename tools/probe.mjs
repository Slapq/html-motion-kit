// 单点探针：在若干时刻量指定元素的"为什么不可见"。
// 复刻 tools/audit.mjs 的判定规则（逐级乘 opacity；display/visibility 直接归零），
// 但把中间结果全部打印出来，用于定位"审计说没文字"到底是哪一级的问题。
//
//   node tools/probe.mjs projects/simple-ppt --at 15.2,16.4,17.0 --sel ".scene:last-child .h2"
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve, ROOT } from './serve.mjs';

const pos = [], opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  else pos.push(argv[i]);
}
const rel = (pos[0] || '').replace(/^projects[\\/]/, '');
if (!rel) { console.error('usage: node tools/probe.mjs <project> --at 1,2 --sel ".h2"'); process.exit(2); }
const times = String(opt.at || '0').split(',').map(Number);
const sel = opt.sel || '.scene *';

const port = 5300 + Math.floor(Math.random() * 500);
// 进程内起服务：不依赖外部 server，也不用等它起来
const server = await serve(port);

const chrome = opt.chrome || process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/projects/${rel}/?export`, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__videoReady === true', { timeout: 60000 });
  const vp = await page.evaluate(() => ({ w: __video.width, h: __video.height }));
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });

  for (const t of times) {
    await page.evaluate((x) => __video.seek(x), t);
    const rows = await page.evaluate((sel, t) => {
      const stage = document.querySelector('.stage');
      const W = stage.clientWidth, H = stage.clientHeight;
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const chain = [];
        let o = 1, blocked = null;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const cs = getComputedStyle(n);
          const vis = cs.visibility, dis = cs.display, op = parseFloat(cs.opacity || '1');
          const tag = n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : '');
          chain.push(`${tag} vis=${vis} disp=${dis} op=${op}`);
          if (dis === 'none' || vis === 'hidden') { blocked = `${tag} ${dis === 'none' ? 'display:none' : 'visibility:hidden'}`; o = 0; break; }
          o *= op;
          if (o < 0.02) { blocked = `${tag} opacity=${op} (累积 ${o.toFixed(3)})`; break; }
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const rr = range.getBoundingClientRect();
        const r = rr.width > 0 && rr.height > 0 ? rr : el.getBoundingClientRect();
        const onScreen = !(r.right <= 0 || r.left >= W || r.bottom <= 0 || r.top >= H);
        out.push({
          txt: (el.textContent || '').trim().slice(0, 18),
          effOpacity: +o.toFixed(3), blocked, onScreen,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          count: o >= 0.4 && onScreen && r.width >= 2 && r.height >= 2,
          chain,
        });
      }
      return out;
    }, sel, t);
    console.log(`\n=== t=${t}s ===`);
    const good = rows.filter((r) => r.count).length;
    console.log(`计入"有内容"的块：${good} / ${rows.length}`);
    for (const r of rows) {
      if (r.count) continue;
      console.log(`  ✗ "${r.txt}" 有效opacity=${r.effOpacity} 在画面内=${r.onScreen} rect=${r.rect}`);
      if (r.blocked) console.log(`      卡在：${r.blocked}`);
      for (const c of r.chain) console.log(`      ${c}`);
    }
    if (good) for (const r of rows.filter((x) => x.count)) console.log(`  ✓ "${r.txt}" o=${r.effOpacity} rect=${r.rect}`);
  }
} finally {
  await browser.close();
  server.close();
}
