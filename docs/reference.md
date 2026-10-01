# Kinema 参考手册

完整 API。上手和工作流见 [README](../README.md)，引擎的坑见 [lessons.md](lessons.md)。

## 三种结构

### 连续镜头（默认）

章节横排在一条长画布上，镜头一路平移，背景和进度轴全程不停，没有翻页感。

```js
await createVideo({
  width: 1920, height: 1080, fps: 30,
  look: 'light', theme: { accent: '#1a73e8' },
  background: 'network',                         // 或 'grid' / { type: 'network', count: 30 } / null
  progress: true,                                // 底部进度轴，刻度来自章节 title
  camera: { ease: 'inOutQuad', maxPx: 80, drift: 0 },
  chapters: [{
    id: 'intro', title: '开场', dur: 5, rhythm: 'dense',
    html: `<div class="wrap mid">…</div>`,
    build(tl, el, ctx) { /* 局部 0 = 镜头开始驶向本章；ctx.arrive = 到位时间 */ },
  }],
});
```

- 引擎自动排版章节、生成镜头关键帧（峰值 ≤ `maxPx`/帧）。`dur` 必须 ≥ 镜头移动时长 + 0.5s，否则报错。
- 内容在 `ctx.arrive` 之前开始入场，镜头到位时画面已经有字。
- `camera.drift` 默认 10px/s（到站后继续漂移），不要就设 0。
- `registerBackground(name, (tl, host, opts) => canvas)` 扩展背景层。
- 只要一个全屏 canvas 也可以：一个章节、`background: null`，在 `tl.add((lt, t) => draw(t))` 里自己画（`mikazuki-pv` 就是这样）。

### 翻页场景

```js
await createVideo({
  width: 1920, height: 1080, fps: 30,
  theme: { accent: '#6ee7ff', accent2: '#a78bfa' },
  music: { src: 'assets/music.mp3', volume: 0.3 },
  ready: [puppet.ready],
  scenes: [{
    id: 'intro', title: '开场', dur: 6, className: 'bg-grad',
    transition: 'zoom',            // 或 { type: 'slide', dur: 1, sfx: 'whoosh' }
    html: `<div class="center"><h1 class="title">…</h1></div>`,
    build(tl, el, ctx) { /* 场景内时间从 0 开始 */ },
  }],
});
```

转场：`cut fade zoom slide up wipe circle flip glitch slash shutter`，与上一场景重叠 `dur` 秒（默认 0.8）。`registerTransition(name, fn, sfx)` 自定义。避免空帧：本场景在最后 `dur` 秒淡出，下一场景在转场一开始就入场。

### 教程

`--mode tutorial` 是连续镜头 + 全片唯一的光标主线 + 跨段交接：

```js
html: `<span class="goal" data-carry="goal">目标：做出第一个结果</span> …`,
build(tl, el, ctx) {
  ctx.cursor([
    { to: el.querySelector('.input'), at: 0.6, dur: 0.8, click: true, press: true },
    { to: [960, 540], at: 2.4 },
    { hide: 5.2 },
  ]);
},
```

- 相邻两段里同名的 `data-carry` 在交界处从 A 的位置飞到 B 的位置；内容不同时几何插值、中段交叉淡化。同一段内重名直接报错。
- 光标路径跨段拼接，跨交界时直接飞过去。`click: true` 会带程序化 click 音。
- `rhythm: 'anchor' | 'dense' | 'breathing'` 只影响审计读数。
- 构建后 `__video.timeline.carry` 里有 `flights` 和每个交界的 `boundaries`。

## Timeline

- `tl.to / from / fromTo(el, props, { at, dur, ease })`，`tl.set(el, props, { at })`
- 属性：`x y scale scaleX scaleY rotate rotateX rotateY opacity blur brightness clip`，以及任意 `--css-var`
- `at`：`2.5` 绝对 · `'+0.3'` 上一项结束后 · `'-0.2'` 重叠 · `'<'` 同时 · `'<0.1'` · `'@drop+0.2'` 命名标记
- `tl.add((lt, t) => …)` 每帧回调（`lt` 场景内，`t` 全局）· `tl.modify(el, lt => deltas, { at, dur })`
- `tl.sfx(name, at, opts)` · `tl.audio(src, at, opts)` · `tl.caption(text, at, dur)` · `tl.marker('drop', 2.4)`
- 缓动：`linear`，`in/out/inOut` × `Quad Sine Cubic`，`outQuart inOutQuart outExpo inOutExpo inBack outBack outBounce outElastic spring`，或自定义函数；未知名字直接报错

## fx

| 函数 | 用途 |
|---|---|
| `textIn(tl, el, { preset, by, stagger, ease, sfx })` | 文字入场。`line` `fade` `blur` 整行；`rise drop pop flip wave` 逐字 |
| `typewriter` `counter` `scramble` | 打字、数字滚动、乱码解码（写 `textContent`，目标须是叶子节点） |
| `staggerIn(tl, els, { from, stagger })` | 列表依次入场 |
| `highlight` `kenBurns` `parallax` `float` `shake` `drawPath` `glitch` | 聚焦与运动 |
| `particles(tl, el, { mode: dust/bokeh/burst/confetti/stars })` | 粒子 |
| `sequence(tl, el, { src: 'td.####.png', count, fps })` | 可寻址的图片序列层（如 TouchDesigner 预渲染） |

部分 fx 默认带音效（`counter` tick、`typewriter` type、`scramble` blip），不要就传 `sfx: null`。

## 声音

- 配乐：`createVideo({ music: { src, volume, fadeIn, fadeOut, loop } })`；素材音 `tl.audio(src, at, opts)`。音频 cue 是全局的，导出时离线渲染后与画面合流。
- 程序化音效（WebAudio 合成，无需素材）：`whoosh swoosh pop click tick type ding success error rise impact sparkle glitch blip air thump soft chime scan bass hud`；鼓机 `tl.sfx('beat', 0, { dur, bpm, pattern: 'x...x...' })`。`registerSfx(name, fn)` 扩展。
- 音频包络：`await analyzeAudio(src, { name, bands: { low: [20, 200] } })`，然后在节点图里 `fx: [{ type: 'envelope', name }]` 或 expr 里 `env("name")`，让画面跟着音乐走。

## 画面层

- **GPU 着色器**：`new ShaderLayer(el, { frag, uniforms }).bind(tl)`，uniform 可补间，也可作为节点 `target: '@sh.uniforms'`。
- **Canvas 伪 3D**：`new Space3D(el, { fov, fog })`，几何 `points polyline plane quad grid lattice sphere ring cloud box`，对象和相机都可补间，`Space3D.along(pts, f)` 取路径点。
- **字符 3D**：`AsciiSpace`，把几何体渲染成字符阵列（`kinema-promo`）。
- **角色**：`MeshPuppet({ src, width, height, headLine })` 对单张透明 PNG / SVG 做网格变形（呼吸、摆动、转头、头发滞后），`emote('bounce' | 'nod' | 'tilt' | 'shake', at)`；`LayeredPuppet` 用分层部件做眨眼和说话，张嘴用 `p.talk(start, end)`（需要嘴部素材，`MeshPuppet` 不支持）。

canvas 层默认 `z-index: 0` 并且是 `appendChild`，会盖住文字，正文要显式设 `z-index`。

## 节点图

借鉴 TouchDesigner 的通道和 Cavalry 的复制器 / 衰减 / 行为。整个场景可以写成 JSON：`tl.graph(env).add(items)` 或 `Graph.fromJSON(tl, json, env)`，也可以直接写在场景的 `graph: [items]` 里，不写 `build`。

```js
const g = tl.graph({ root: el, stage: el, refs: { ring, runner } });
g.add([
  { kind: 'node', id: 'beat', type: 'channel', params: { v: { value: 0, fx: [{ type: 'pulse', bpm: 120 }] } } },
  { kind: 'node', id: 'dots', type: 'duplicator', parent: '@stage', html: '<i class="dot"></i>', count: 48,
    distribution: { type: 'grid', cols: 12, spacing: [60, 60] },
    falloff: { type: 'radial', center: { expr: '[960 + sin(t) * 400, 540]' }, radius: 360 },
    params: { scale: { value: 1, fx: [{ type: 'falloff', rest: 0.2 }], expr: 'value * (1 + ch("beat.v") * 0.3)' } } },
  { kind: 'node', id: 'ring', type: 'object', target: '@ring', params: { ry: { expr: 't * 30' } } },
  { kind: 'op', op: 'counter', target: '.hud', params: { to: 42195 } },
  { kind: 'preset', preset: 'wobble', target: '.hud', params: { amp: 2 } },
]);
```

- 节点：`channel`（纯数据）、`layer`（DOM）、`object`（任意对象，如 Space3D 物体、`@runner.params`）、`duplicator`（批量复制，DOM 或 Space3D）。
- 参数 spec：`{ value, keys: [[t, v, ease]], loop, delay, stagger, link, lag, mul, add, fx, expr, min, max }`，求值顺序 value / keys / link → fx → expr → min / max。`keys` 里的 ease 管的是**到达**这一键的那段。
- `mode: 'set'`（默认，覆盖）或 `'add'`（叠加在 tween 上）。
- 行为 fx：`noise oscillate spring pulse step random falloff quantize math envelope`。
- 分布：`grid line circle spiral random points`；衰减：`none radial linear index noise`，可叠加 `falloff: [a, { ...b, blend: 'add' }, { ...c, blend: 'multiply', invert: true }]`。
- expr 变量 `t lt i n u w px py value`，函数 `ch() env() lerp clamp noise hash TAU` 和全部 Math。expr 用 `new Function` 执行，只放项目内受信代码。
- 算子：`tween set textIn typewriter counter staggerIn kenBurns float shake drawPath scramble glitch highlight particles emote talk sfx caption`，也可 `tl.op('shake', el, { amp: 8 })`；预设 `wobble beatPulse popIn`。
- 扩展：`defineOp` `definePreset` `registerBehaviour` `registerDistribution` `registerFalloff`。
- 实时：`g.set('beat.v', 0.5)`、`g.get('dots.scale', t)`。

## 可追溯与检查器

- 每个 tween、modifier、renderer 都带来源 `src`；`tl.trace(label, fn)` 手动打标签，`tl.name(target, '名字')` 命名目标。
- 纯查询：`tl.evaluate(target, t)`、`tl.valueAt(target, prop, t)`、`tl.sample(target, prop, t0, t1, n)`。
- `tl.inspect()` 返回可序列化的完整轨迹（targets、ops、graphs、cues、captions），预览页 `player.inspect()` 同样可用。它是构建期查询，别放进每帧回调。
- 预览时按 `I`（或 URL 加 `?inspect`）打开检查器：轨道与曲线、可直接改值的节点参数、算子调用记录、导出 JSON。导出时不出现。

## Input props

`createVideo({ props })` 给默认值，可被 `?props=<json>` 或 `render --props file.json` 覆盖；html 和 graph 中用 `{{name}}`，代码中用 `ctx.props`。同一页面换数据批量出片。

## TouchDesigner 预渲染序列

TouchDesigner 不能被浏览器逐帧驱动，所以走预渲染：

1. TD 里 `Movie File Out TOP`，Type 设为 Image Sequence（PNG），输出到 `projects/<name>/assets/td/td.0001.png …`。
2. 场景中 `fx.sequence(tl, el, { src: 'assets/td/td.####.png', start: 1, count: 180, fps: 30, blend: 'screen' })`，返回的 `ready` 放进 `createVideo({ ready })`。

非商业版 TD 输出上限 1280×1280（`fit: 'cover'` 会放大）。WebSocket 实时互动只能用于预览，不能用于导出。

## 命令行参数

`render`：`--out --fps --from --to --scale --crf --mute --chrome --still --props --workers --inspect`。`--out` 相对当前目录，`--inspect trace.json` 导出 `tl.inspect()` 轨迹。页面带 `?export` 时隐藏控制条。

`audit`：`--to <秒>` 只扫前一段，`--step`，`--no-hints` 关闭风格读数。

`pacing`：`--limit`（默认 0.5s）、`--end-hold`（末章，默认 3s）只决定哪些行打 ✗，退出码恒为 0；`--step`、`--quiet`。

## Agent 工具接口

`dsh/` 把上面的命令包装成六个工具，供 DeepSeek Harness 等 Agent 宿主直接调用，结果与命令行一致：

| 工具 | 作用 |
|---|---|
| `motion_info` | 根目录、README 路径、已有项目 |
| `motion_new` | 创建项目（`continuous` / `scenes` / `tutorial`） |
| `motion_audit` | 阻塞问题 + 读数 |
| `motion_pacing` | 每章空等读数 |
| `motion_still` | 单帧 PNG，可传 `props` |
| `motion_render` | 导出 MP4，支持 `from / to / fps / workers / props` |

项目名只允许字母、数字、`-`、`_`，输出文件必须在项目目录内。配置（`dsh/cordis.patch.yml`）：`root`（项目根，默认本仓库）、`timeoutSec`（默认 1800）。

```bash
dsh plugin --profile web add link:$(pwd)
```

## 测试

`npm test`（`node --test tests/*.test.mjs`），不依赖 DOM。
