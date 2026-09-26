// DeepSeek Harness (DSH) plugin: exposes HTML Motion Kit to the agent as tools + a skill.
//
//   dsh plugin --profile web add link:<path-to>/html-motion-kit
//
// Tools run the kit's own CLIs (tools/new-project.mjs, tools/render.mjs) as child processes,
// so the plugin adds no second implementation; everything stays inside <root>/projects.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'html-motion-kit';
export const inject = ['tools', 'skills'];

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_RE = /^[\w-]+$/;
const loose = { type: 'object', additionalProperties: true };
const text = (s) => [{ type: 'text', text: s }];
const out = { schema: loose, render: (_a, v) => text(v.message ?? '') };

export const SKILL_BODY = `# HTML Motion Kit

帧精确的 HTML/JS 动态图形与视频框架。画面是时间 t 的纯函数；预览、抽帧、导出一致。
完整 API 见 motion_info 返回的 README 路径（场景、Timeline、fx、节点图、ShaderLayer、音频包络、叠加衰减、markers、props）。

## 工作流
1. motion_new 生成 projects/<name>/index.html（三幕模板）。
2. 编辑 index.html：createVideo({ scenes: [{ id, dur, html, build(tl, el) {…}, graph: [...], transition, markers }] })。
3. motion_still 在关键时间点抽帧，用图片查看工具检查画面；有问题改完再抽。
4. motion_render 导出 MP4（长视频用 workers: 4）。

## 约定
- 所有动画挂在 tl 上（tl.to / fromTo / add / caption / sfx），不要用 setTimeout、CSS animation、Math.random。
- 节点图参数可写关键帧、link、fx、expr；未知节点 / 标记 / blend 会直接报错，看报错改。
- 同一页面换数据用 props（{{name}} 占位符），不要复制项目。
- 页面报错会出现在工具输出的 [page error] 行里。`;

function resolveConfig(config = {}) {
  const root = path.resolve(config.root || PKG_ROOT);
  if (!existsSync(path.join(root, 'tools', 'render.mjs'))) throw new Error(`html-motion-kit: ${root} 不是 HTML Motion Kit 根目录`);
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
      description: '列出 HTML Motion Kit 的根目录、README（完整 API）路径和已有视频项目。写视频前先调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: out,
      async execute() {
        const projects = listProjects();
        return {
          ok: true, root: cfg.root, projects,
          message: `根目录：${cfg.root}\nREADME：${path.join(cfg.root, 'README.md')}\n示例：${path.join(cfg.root, 'projects', 'graph-showcase', 'index.html')}\n项目：${projects.join(', ') || '（无）'}\n项目文件：<root>/projects/<name>/index.html`,
        };
      },
    },
    {
      name: 'motion_new',
      description: '创建新视频项目 projects/<name>（index.html 三幕模板 + assets.json）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '项目名：字母、数字、- 或 _' },
          title: { type: 'string', description: '视频标题（可选）' },
        },
        required: ['name'], additionalProperties: false,
      },
      output: out,
      async execute(args, exec) {
        try {
          if (!NAME_RE.test(args?.name ?? '')) throw new Error('name 只能包含字母、数字、- 和 _');
          const r = await runNode(cfg, 'new-project.mjs', [args.name, ...(args.title ? ['--title', args.title] : [])], exec?.signal);
          const file = path.join(cfg.root, 'projects', args.name, 'index.html');
          return { ok: r.ok, path: r.ok ? file : undefined, message: r.ok ? `已创建 ${file}` : `创建失败：\n${r.log}` };
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
      name: 'html-motion-kit',
      description: '用 HTML Motion Kit 制作帧精确的动态图形 / 宣传视频并导出 MP4。',
      whenToUse: '用户要做视频、动画、宣传片、动态图形、片头，或要把网页内容做成 MP4 时。',
      content: SKILL_BODY,
    });
    return () => dispose();
  }, 'html-motion-kit: skill');
  ctx.effect(() => {
    const disposers = makeTools(cfg).map((t) => ctx.tools.register(t));
    return () => { for (const d of disposers) d(); };
  }, 'html-motion-kit: tools');
}

export { resolveConfig };
