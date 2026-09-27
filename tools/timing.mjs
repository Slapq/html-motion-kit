// 从项目源码算出实际时序：场景全局区间 + 每个动画的全局起止。
// 用来在改时间轴之前先看到结果，而不是改一次跑一次审计。
import fs from 'node:fs';

const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const T = +(raw.match(/const T = ([\d.]+)/)?.[1] ?? 0.6);

// 场景：id / title / dur（按出现顺序）
const scenes = [...raw.matchAll(/id: '([\w-]+)', title: '[^']*', dur: ([\d.]+)/g)]
  .map((m) => ({ id: m[1], dur: +m[2] }));
if (!scenes.length) { console.error('没解析到场景，检查 id/title/dur 写法'); process.exit(1); }

const starts = [];
let cursor = 0;
scenes.forEach((s, i) => {
  const td = i === 0 ? 0 : T;
  const start = Math.max(0, cursor - td);
  starts.push(start);
  cursor = start + s.dur;
});
const total = cursor;

console.log(`转场 T=${T}s   总时长 ${total.toFixed(2)}s = ${Math.round(total * 30)} 帧\n`);
console.log('场景');
scenes.forEach((s, i) => {
  console.log(`  ${s.id.padEnd(8)} 全局 ${starts[i].toFixed(2).padStart(6)} → ${(starts[i] + s.dur).toFixed(2).padStart(6)}  (dur ${s.dur})`);
});

// 每个场景的 build 里，tl.* 的 at 值是场景内绝对时间（数字字面量），换算成全局时间。
// 只看裸数字，字符串形式（'+0.3' 之类）单独标注，因为它们的语义是"相对上一项"。
console.log('\n场景内动画（已换算成全局时间）');
let cur = -1;
for (const line of raw.split('\n')) {
  const s = line.match(/id: '([\w-]+)', title:/);
  if (s) { cur = scenes.findIndex((x) => x.id === s[1]); continue; }
  if (cur < 0) continue;
  const at = line.match(/\bat: ([\d.]+)(?!\d)/);
  if (!at) continue;
  const rel = line.match(/at: '([^']+)'/);
  const label = line.match(/(tl\.\w+|fx\.\w+|leave|addPager)/)?.[1]
    ?? line.trim().split(/[.(]/)[0];
  const g = starts[cur] + +at[1];
  console.log(`  ${scenes[cur].id.padEnd(8)} ${g.toFixed(2).padStart(6)}  ${label}${rel ? `   [相对: ${rel[1]}]` : ''}`);
}
