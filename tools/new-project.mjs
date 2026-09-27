#!/usr/bin/env node
// Scaffold a new video project:
//   npm run new -- my-video [--title "标题"] [--mode continuous|scenes|tutorial]
// continuous（默认）：长画布 + 镜头 + 背景 + 进度轴；scenes：翻页式场景 + 转场；
// tutorial：连续模式 + 贯穿全片的光标主线 + data-carry 交接 + rhythm 标签。
// 两种模板都走浅色克制风格（白底 + 单一主色，整行入场），模板在 tools/templates/。
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOT } from './serve.mjs';

const MODES = ['continuous', 'scenes', 'tutorial'];
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  else pos.push(argv[i]);
}
const name = pos[0];
const title = typeof opt.title === 'string' ? opt.title : name;
const mode = opt.mode === undefined ? 'continuous' : opt.mode;
const usage = 'usage: npm run new -- <name> [--title "标题"] [--mode continuous|scenes|tutorial]  (name: letters, digits, - _)';
if (!name || !/^[\w-]+$/.test(name)) { console.error(usage); process.exit(2); }
if (!MODES.includes(mode)) { console.error(`unknown --mode "${mode}"; available: ${MODES.join(' ')}`); process.exit(2); }

const dir = path.join(ROOT, 'projects', name);
if (existsSync(dir)) { console.error(`projects/${name} already exists`); process.exit(1); }

const esc = (s) => String(s).replace(/[&<>"`$\\]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '`': '&#96;', $: '&#36;', '\\': '&#92;' })[c]);
const tpl = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', `${mode}.html`);
const html = (await fs.readFile(tpl, 'utf8')).replaceAll('__TITLE__', esc(title));

const manifest = {
  defaults: { quality: 'high', size: '1536x1024' },
  images: [
    { out: 'assets/hero.png', prompt: 'Clean minimal product illustration on a white background, single blue accent, generous empty space, no text, no logos' },
  ],
};
await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
await fs.writeFile(path.join(dir, 'index.html'), html);
await fs.writeFile(path.join(dir, 'assets.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ projects/${name}  (${mode})
  node tools/audit.mjs projects/${name} --step 0.1   → 改完必须 问题 0 条
  npm run serve        → http://127.0.0.1:5173/projects/${name}/
  npm run render -- projects/${name}`);
