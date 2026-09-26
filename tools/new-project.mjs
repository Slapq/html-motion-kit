#!/usr/bin/env node
// Scaffold a new video project:  npm run new -- my-video [--title "标题"]
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith('--'));
const ti = argv.indexOf('--title');
const title = ti >= 0 ? argv[ti + 1] : name;
if (!name || !/^[\w-]+$/.test(name)) { console.error('usage: npm run new -- <name> [--title "标题"]  (name: letters, digits, - _)'); process.exit(2); }

const dir = path.join(ROOT, 'projects', name);
if (existsSync(dir)) { console.error(`projects/${name} already exists`); process.exit(1); }
await fs.mkdir(path.join(dir, 'assets'), { recursive: true });

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="../../engine/base.css">
  <style>
    /* project styles */
  </style>
</head>
<body>
<script type="module">
  import { createVideo, MeshPuppet, fx } from '../../engine/index.js';

  // Use a generated asset when present, otherwise the fallback (null = omit).
  const asset = async (png, fallback = null) => ((await fetch(png, { method: 'HEAD' })).ok ? png : fallback);
  const bg = await asset('assets/bg.png');

  await createVideo({
    width: 1920, height: 1080, fps: 30,
    theme: { accent: '#6ee7ff', accent2: '#a78bfa' },
    scenes: [
      {
        id: 'intro', title: '开场', dur: 5, className: 'bg-grad',
        html: \`
          \${bg ? \`<img class="bg-image" src="\${bg}">\` : ''}
          <div class="center">
            <h1 class="title grad-text">${esc(title)}</h1>
            <p class="subtitle">一句话介绍</p>
          </div>\`,
        build(tl, el) {
          const img = el.querySelector('.bg-image');
          if (img) fx.kenBurns(tl, img, { dur: 5 });
          fx.particles(tl, el, { mode: 'bokeh', count: 20, colors: ['#6ee7ff', '#a78bfa'] });
          fx.textIn(tl, el.querySelector('.title'), { at: 0.5, preset: 'blur', stagger: 0.04, sfx: 'rise' });
          fx.textIn(tl, el.querySelector('.subtitle'), { at: '-0.2', preset: 'rise', stagger: 0.03 });
        },
      },
      {
        id: 'features', title: '功能', dur: 6, transition: 'slide', className: 'bg-grad',
        html: \`
          <div class="center"><div class="card" style="width:1100px">
            <ul class="bullets"><li>要点一</li><li>要点二</li><li>要点三</li></ul>
          </div></div>\`,
        build(tl, el) {
          fx.staggerIn(tl, el.querySelectorAll('.bullets li'), { at: 0.6, stagger: 0.5, from: { x: 60, opacity: 0 }, sfx: 'blip' });
          tl.caption('字幕文本', 1, 3.5);
        },
      },
      {
        id: 'outro', title: '结尾', dur: 4, transition: 'circle', className: 'bg-grad',
        html: \`<div class="center"><h1 class="title">谢谢观看</h1></div>\`,
        build(tl, el) {
          fx.textIn(tl, el.querySelector('.title'), { at: 0.6, preset: 'pop', stagger: 0.06, sfx: 'pop' });
          tl.to(el, { opacity: 0 }, { at: 3.3, dur: 0.7 });
        },
      },
    ],
  });
</script>
</body>
</html>
`;
const manifest = {
  defaults: { quality: 'high', size: '1536x1024' },
  images: [
    { out: 'assets/bg.png', prompt: 'Wide cinematic abstract background, dark navy gradient, soft glowing shapes, empty center for a title, no text, no logos' },
  ],
};
await fs.writeFile(path.join(dir, 'index.html'), html);
await fs.writeFile(path.join(dir, 'assets.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ projects/${name}
  npm run img -- --manifest projects/${name}/assets.json
  npm run serve        → http://127.0.0.1:5173/projects/${name}/
  npm run render -- projects/${name}`);
