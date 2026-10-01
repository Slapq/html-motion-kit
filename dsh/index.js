// DeepSeek Harness (DSH) plugin: exposes Kinema to the agent as tools + a skill.
//
//   dsh plugin --profile web add link:<path-to>/kinema
//
// Tools run the kit's own CLIs (tools/new-project.mjs, tools/render.mjs) as child processes,
// so the plugin adds no second implementation; everything stays inside <root>/projects.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'kinema';
export const inject = ['tools', 'skills'];

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[\w-]+$/;
const loose = { type: 'object', additionalProperties: true };
const text = (s) => [{ type: 'text', text: s }];
const out = { schema: loose, render: (_a, v) => text(v.message ?? '') };

export const SKILL_BODY = `# Kinema

帧精确的 HTML/JS 动态图形与视频框架。画面是时间 t 的纯函数；预览、抽帧、导出一致。
完整 API 见 <root>/docs/reference.md（motion_info 会返回根目录）（场景、Timeline、fx、节点图、ShaderLayer、音频包络、叠加衰减、markers、props）。
**开工前请读 <root>/docs/lessons.md**：引擎会静默失效的 API 和版面坑。它只记事实，不规定片子长什么样。

## 工作流
1. motion_new 生成 projects/<name>/index.html。mode 三选一（默认 continuous）：
   - continuous：createVideo({ chapters: [{ id, title, dur, html, build(tl, el, ctx) }] })。章节横排在长画布上，镜头自动平移（已限速），背景和进度轴全程不停。
     章节局部时间 0 = 镜头开始驶向本章，ctx.arrive = 镜头到位时间；内容在 arrive 之前就开始入场。
   - scenes：createVideo({ scenes: [{ id, dur, html, build, transition: { type: 'fade', dur: T } }] })。翻页式。
     本场景内容在最后 T 秒淡出，下一场景内容在转场一开始（at≈0.05）就入场，两者交叉才没有空帧。
   - tutorial：连续模式 + 贯穿全片的光标主线（ctx.cursor）+ data-carry 交接 + rhythm 标签。做教程/产品演示选它。
   两种模板都已写好 look: 'light'、theme.accent、background: 'network'、progress: true；**先改文字，别先改结构**。
2. 编辑 index.html：只替换文字、增删章节、调 dur。入场统一用 fx.textIn(tl, el, { at, preset: 'line' })（小字可用 'fade'），卡片用 fx.staggerIn。
0. **先定这一支片子的原则**：一句话写下给谁看、要让人记住什么；有参考就逐帧拆参考（镜头长短、运动能量、转场、配色、字的运动），没有就问用户或自己找。
   原则写在 index.html 顶部注释里，只对这一支片子有效。教程要稳、要留阅读时间；MV 要卡点、要甩镜头、要冲击——不同片子可以相反。追求最好，不是追求不出错。
3. **motion_audit 找坏掉的地方**（写完前 2~3 段就先跑，传 to 只扫这一段）。只有「裁切」「出画」和页面报错是阻塞项，导出前必须为 0；
   其余（压叠、空帧/偏空、静止、对比度、镜头速度、rhythm、交接、颜色/字号）都是读数，按这一支片子的原则判断要不要改，不要为了读数归零去改设计。
4. motion_pacing 量每章演完后空等了多久，也只是读数。之后抽帧、看导出的 mp4、和参考并排比——好不好看靠看，不靠指标。
5. motion_render 导出 MP4（长视频用 workers: 4）。

## 交接与节奏（可用的手段，不是必须）
- 交接：相邻两段里放同名 data-carry="名字" 的元素，交界处它会在屏幕空间飞过去（几何插值，内容不同时中间 30% 交叉淡化）。
- 光标：build(tl, el, ctx) 里 ctx.cursor([{ to: el 或 [x,y], at, dur, click: true, press: true }, { hide: t }])；全片只有一个光标，会自己飞过交界。click: true 会带引擎的程序化点击音。
- rhythm：场景/章节可标 'anchor' / 'dense' / 'breathing'，审计据此调整读数。
- 引擎里默认会出声的地方（counter / typewriter / scramble / particles / 光标 click）：不想要就显式 sfx: null。
- 用户否定了什么，就问清楚他要什么，在这一支片子里改；docs/lessons.md 末尾的「历史项目备注」是以前片子的原话，只当参考。

## 约定
- tl.to([el1, el2]) 传数组是**静默无效**的：多个元素用 fx.staggerIn 或逐个 tl.to。
- 所有动画挂在 tl 上（tl.to / fromTo / add / caption / sfx），不要用 setTimeout、CSS animation、Math.random。
- 节点图参数可写关键帧、link、fx、expr；未知节点 / 标记 / blend 会直接报错，看报错改。
- 同一页面换数据用 props（{{name}} 占位符），不要复制项目。
- 页面报错会出现在工具输出的 [page error] 行里。

## 最容易犯的错（详见 docs/lessons.md）
- 未知缓动名 / textIn 预设 / 转场 / 粒子模式 / look 都会**直接抛错**，看报错里的 available 列表改。
- textIn 预设：line（整行上浮，大标题首选）、fade、rise、drop、blur、pop、flip、wave；line/fade/blur 整行动，其余逐字。
- graph 的 keys，ease 作用在**到达该键**的那一段。
- 音频 cue 是**全局**的（带场景偏移），第一幕排的 pad 能铺满全片。
- CLI 的 --out 相对 **CWD** 解析（工具 motion_* 才约束在项目目录内）。
- 绝对定位元素给**成对**偏移；单文件只有一份全局 CSS，类名要按章节命名空间。
- 浅色主题要覆盖 .stage 背景和 .captions；ShaderLayer/Space3D 的 canvas 默认盖在内容上，正文需显式 z-index。
- 大字号中文的 line-height 用 **normal**：CJK 自然行高约 1.25em，写死 1.2 也会被审计判「裁切」。
- **inline 元素不吃 transform**：给 em / span 做 scale 动画前先 display: inline-block，否则静默无效。
- camera.drift 默认 10px/s：到站后镜头继续平移，画面元素一直往左飘。要关就 drift: 0。
- 别用弹幕凑"B 站风"（配色 + 大标题 + UP 主条 + 进度轴 + 三连就够了）；片子由 agent 生成时，结尾/角落加一行生成署名。`;

function resolveConfig(config = {}) {
  const root = path.resolve(config.root || PKG_ROOT);
  if (!existsSync(path.join(root, 'tools', 'render.mjs'))) throw new Error(`kinema: ${root} 不是 Kinema 根目录`);
  return { root, timeoutSec: config.timeoutSec ?? 1800 };
}

// Resolve a project name to its directory, refusing anything outside <root>/projects.
function projectDir(cfg, project) {
  if (typeof project !== 'string' || !NAME_RE.test(project)) throw new Error('project 只能包含字母、数字、- 和 _');
  const dir = path.join(cfg.root, 'projects', project);
  if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`projects/${project} 不存在（先用 motion_new 创建）`);
  return dir;
}
function inside(dir, file) {
  const p = path.resolve(dir, file);
  if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error(`输出路径必须在项目目录内：${file}`);
  return p;
}

function runNode(cfg, script, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cfg.root, 'tools', script), ...args], { cwd: cfg.root, windowsHide: true });
    let log = '';
    const keep = (b) => { log = (log + b.toString()).slice(-6000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, cfg.timeoutSec * 1000);
    child.on('error', (e) => { keep(String(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', kill);
      resolve({ ok: code === 0 && !signal?.aborted, code, log: log.replace(/\r/g, '\n').replace(/\n{2,}/g, '\n').trim() });
    });
  });
}

async function withProps(props, fn) {
  if (props == null) return fn([]);
  if (typeof props !== 'object' || Array.isArray(props)) throw new Error('props 必须是对象');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmk-'));
  const file = path.join(dir, 'props.json');
  await fs.writeFile(file, JSON.stringify(props));
  try { return await fn(['--props', file]); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const fail = (e) => ({ ok: false, message: `失败：${e instanceof Error ? e.message : String(e)}` });

export function makeTools(cfg) {
  const listProjects = () => readdirSync(path.join(cfg.root, 'projects')).filter((d) => existsSync(path.join(cfg.root, 'projects', d, 'index.html')));
  return [
    {
      name: 'motion_info',
      description: '列出 Kinema 的根目录、参考手册（完整 API）路径和已有视频项目。写视频前先调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: out,
      async execute() {
        const projects = listProjects();
        return {
          ok: true, root: cfg.root, projects,
          message: `根目录：${cfg.root}\n参考手册：${path.join(cfg.root, 'docs', 'reference.md')}\n示例：${path.join(cfg.root, 'projects', 'graph-showcase', 'index.html')}\n项目：${projects.join(', ') || '（无）'}\n项目文件：<root>/projects/<name>/index.html`,
        };
      },
    },
    {
      name: 'motion_new',
      description: '创建新视频项目 projects/<name>（index.html + assets.json）。mode: continuous（默认，长画布 + 镜头 + 背景 + 进度轴）、scenes（翻页 + 转场）或 tutorial（连续模式 + 光标主线 + data-carry 交接）；模板都是浅色克制风格，审计 0 问题。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '项目名：字母、数字、- 或 _' },
          title: { type: 'string', description: '视频标题（可选）' },
          mode: { type: 'string', enum: ['continuous', 'scenes', 'tutorial'], description: '模板模式（默认 continuous）' },
        },
        required: ['name'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          if (!NAME_RE.test(args?.name ?? '')) throw new Error('name 只能包含字母、数字、- 和 _');
          if (args.mode !== undefined && !['continuous', 'scenes', 'tutorial'].includes(args.mode)) throw new Error('mode 只能是 continuous、scenes 或 tutorial');
          const r = await runNode(cfg, 'new-project.mjs', [args.name, ...(args.title ? ['--title', args.title] : []), ...(args.mode ? ['--mode', args.mode] : [])], exec?.signal);
          const file = path.join(cfg.root, 'projects', args.name, 'index.html');
          return { ok: r.ok, path: r.ok ? file : undefined, message: r.ok ? `已创建 ${file}` : `创建失败：\n${r.log}` };
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'motion_audit',
      description: '版面审计：一次无头浏览器扫完整条时间轴，用数字报出文字被裁、内容出画、文字压叠、空帧/偏空、画面静止、节奏标签违规、页面报错、镜头单步位移、交接、颜色/字号。只有裁切、出画和页面报错是阻塞项；其余是读数，按这一支片子的原则判断。只量 DOM 文字，全部画在 canvas 上的片子空帧/偏空读数无意义。写完前 2~3 段就先跑一次（用 to 限定范围）。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'projects/ 下的项目名' },
          step: { type: 'number', description: '采样间隔秒数（默认 0.2，精查用 0.1）' },
          from: { type: 'number', description: '起始秒（可选）' },
          to: { type: 'number', description: '结束秒（可选）' },
        },
        required: ['project'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          const dir = projectDir(cfg, args?.project);
          const flags = [];
          for (const k of ['step', 'from', 'to']) {
            if (args[k] === undefined) continue;
            if (!Number.isFinite(args[k]) || args[k] < 0) throw new Error(`${k} 必须是非负数`);
            flags.push(`--${k}`, String(args[k]));
          }
          const r = await runNode(cfg, 'audit.mjs', [dir, ...flags], exec?.signal);
          return { ok: r.ok, message: r.log || (r.ok ? '审计通过' : '审计失败') };
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'motion_pacing',
      description: '节奏读数：量每章「最后一拍 → 章末」空等了多久。只输出读数、不判对错：教程里空等 5s 通常是拖沓，MV 里同样的 5s 可能是故意的留白。limit / endHold 只决定哪些行打 ✗。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'projects/ 下的项目名' },
          limit: { type: 'number', description: '标记阈值秒数（默认 0.5）' },
          endHold: { type: 'number', description: '最后一幕的标记阈值秒数（默认 3）' },
          step: { type: 'number', description: '采样间隔秒数（默认 0.05，越小心越准）' },
        },
        required: ['project'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          const dir = projectDir(cfg, args?.project);
          const flags = [];
          if (args.limit !== undefined) {
            if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('limit 必须是正数');
            flags.push('--limit', String(args.limit));
          }
          if (args.endHold !== undefined) {
            if (!Number.isFinite(args.endHold) || args.endHold < 0) throw new Error('endHold 必须是非负数');
            flags.push('--end-hold', String(args.endHold));
          }
          if (args.step !== undefined) {
            if (!Number.isFinite(args.step) || args.step <= 0) throw new Error('step 必须是正数');
            flags.push('--step', String(args.step));
          }
          const r = await runNode(cfg, 'pacing.mjs', [dir, ...flags], exec?.signal);
          return { ok: r.ok, message: r.log || (r.ok ? '节奏 OK' : '有章节空等超限') };
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'motion_still',
      description: '把项目在时间 t（秒）的画面渲染成 PNG，返回图片路径。用于检查构图和动画。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'projects/ 下的项目名' },
          t: { type: 'number', description: '时间（秒）' },
          props: { type: 'object', description: '覆盖 input props（可选）' },
        },
        required: ['project', 't'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          const dir = projectDir(cfg, args?.project);
          if (!Number.isFinite(args.t) || args.t < 0) throw new Error('t 必须是非负数');
          const file = inside(dir, `still-${args.t}.png`);
          const r = await withProps(args.props, (extra) => runNode(cfg, 'render.mjs', [dir, '--still', String(args.t), '--out', file, ...extra], exec?.signal));
          return { ok: r.ok, path: r.ok ? file : undefined, message: r.ok ? `已渲染 ${file}${r.log ? `\n${r.log}` : ''}` : `渲染失败：\n${r.log}` };
        } catch (e) { return fail(e); }
      },
    },
    {
      name: 'motion_render',
      description: '把项目导出为 MP4（含程序化音频）。可只导出一段，可并行。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'projects/ 下的项目名' },
          out: { type: 'string', description: '输出文件，相对项目目录（默认 out.mp4）' },
          from: { type: 'number', description: '起始秒（可选）' },
          to: { type: 'number', description: '结束秒（可选）' },
          fps: { type: 'number', description: '帧率（默认项目设置）' },
          workers: { type: 'number', description: '并行浏览器数（默认 1，长视频建议 4）' },
          props: { type: 'object', description: '覆盖 input props（可选）' },
        },
        required: ['project'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          const dir = projectDir(cfg, args?.project);
          const file = inside(dir, args.out || 'out.mp4');
          if (!/\.mp4$/i.test(file)) throw new Error('out 必须是 .mp4 文件');
          const flags = [];
          for (const k of ['from', 'to', 'fps', 'workers']) {
            if (args[k] === undefined) continue;
            if (!Number.isFinite(args[k]) || args[k] < 0) throw new Error(`${k} 必须是非负数`);
            flags.push(`--${k}`, String(args[k]));
          }
          const r = await withProps(args.props, (extra) => runNode(cfg, 'render.mjs', [dir, '--out', file, ...flags, ...extra], exec?.signal));
          return { ok: r.ok, path: r.ok ? file : undefined, message: r.ok ? `已导出 ${file}\n${r.log}` : `导出失败：\n${r.log}` };
        } catch (e) { return fail(e); }
      },
    },
  ];
}

export function apply(ctx, config) {
  // Mount once per host process (profile reloads re-run apply).
  const seen = (globalThis.__dshMountOnce ??= new Set());
  if (seen.has(name)) return;
  seen.add(name);
  const cfg = resolveConfig(config);
  ctx.effect(() => {
    const dispose = ctx.skills.register({
      name: 'kinema',
      description: '用 Kinema 制作帧精确的动态图形 / 宣传视频并导出 MP4。',
      whenToUse: '用户要做视频、动画、宣传片、动态图形、片头，或要把网页内容做成 MP4 时。',
      source: 'runtime',
      content: SKILL_BODY,
    });
    return () => dispose();
  }, 'kinema: skill');
  ctx.effect(() => {
    const disposers = makeTools(cfg).map((t) => ctx.tools.register(t));
    return () => { for (const d of disposers) d(); };
  }, 'kinema: tools');
}

export { resolveConfig };
