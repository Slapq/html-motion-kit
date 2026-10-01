# 实战经验

这份文档只记**引擎和工具的事实**：哪些 API 会静默失效、哪些写法会让版面坏掉。它不规定片子该长什么样。

审美不在这里定。以前这里堆过一长串"不许静止""镜头 ≤80px/帧""节拍别接到画面""breathing ≤30%"之类的规则，每条都来自某一支片子里用户的一句话。把它们当成全局约束之后，模型为了同时满足所有条，只会做出谁都挑不出错、但也没人想看的片子。那些原话还在，挪到了末尾的「历史项目备注」，只当参考。

---

## 0. 怎么做出好片

1. **先弄清这支片子是给谁看的、要让人记住什么**，用一句话写下来。拿不准就问用户，比做完再推翻便宜得多。
2. **找参考，从参考里提炼这一支片子的原则**。用户给了参考就逐帧拆它（运动能量、镜头长短、转场方式、配色、字的运动），没给就问或自己找。原则写在项目自己的 brief 或 `index.html` 顶部注释里，只对这一支片子有效。不同的片子可以有相反的原则：教程要稳、要留阅读时间；MV 要卡点、要甩镜头、要冲击。
3. **追求最好，不是追求不出错**。如果一个决定只是因为"这样比较安全"，那多半是错的。
4. **看成片，不看指标**。抽帧、看导出的 mp4、和参考并排比。工具只告诉你哪里坏了（见 §6），不告诉你好不好看。
5. **用户否定了什么，就问清楚他要的是什么**，然后在这一支片子里改。别把它写成下一支片子的禁令。

---

## 1. API 事实（别猜，读源码）

猜 API 是最高频的失败来源。以下都是**亲自踩过**的：

| 你以为 | 事实 | 后果 / 出处 |
|---|---|---|
| `inOutSine` 能用 | 早期**没有 Sine**，未知名字静默回退 | 已修：未知缓动名**直接抛错**并列出可用名（`engine/ease.js` 的 `resolveEase`）。textIn 预设、转场类型、粒子模式、rhythm 同样会报 |
| `tl.to([a, b], …)` 能同时动两个 | 传数组是**静默无效**：`isEl` 对数组返回 false，什么都不发生 | 多个元素用 `fx.staggerIn` 或逐个 `tl.to`（marathon 踩过） |
| `keys: [[t, v, ease]]` 的 ease 管"从这一键出发" | 管的是**到达这一键**的那一段 | `engine/graph.js:86`。搞反会"该停时在动、该动时停住" |
| `__video.info` | 没有这个字段 | 实际是 `width/height/fps/duration/chapters/props/seek/audioWav/hasAudio/inspect/timeline`。`seek(t)` 返回 Promise，resolve 时已完成一帧 |
| `tl.add((lt, t) => …)` 的第二参是场景时间 | 第二参是**全局时间**，第一参才是场景内的 | `engine/player.js`；每帧回调按注册顺序执行 |
| 音效只在本场景响 | 音频 cue 是**全局**的：`this._o + this._t(at)` | 第一幕排一条 `pad dur: 24` 能铺满全片 |
| `--out` 相对项目目录 | CLI 的 `--out` **相对 CWD** | DSH 的 `motion_still` 才约束在项目目录内 |
| `ShaderLayer` / `Space3D` 自动垫底 | canvas 是 `appendChild`，默认 `z-index: 0` | 会**盖在文字上面**，正文要显式 `z-index` |
| `base.css` 够用 | `.stage` 是深色 `--bg:#0b0f1a`，`.captions` 黑底白字 | 浅色主题必须覆盖这两个（或用 `look: 'light'`） |
| `fx.textIn` 会吞掉嵌套元素 | **看预设**：`line` / `fade` 是整行 `tl.from`，**保留** `<em>` 等子元素；只有逐字预设（`rise drop blur pop flip wave`）才 `splitText` 重写 innerHTML（`engine/effects.js:57`） | 实测：`preset:'fade'` 下 `<em>` 健在——别凭印象怪 textIn，先量 |
| `counter` / `typewriter` 能写进任意元素 | 用 `textContent` 写入，子元素会被清掉 | 目标必须是叶子节点，如 `<b class="n1">0</b>` |
| 同一段里两个 `data-carry="x"` 没关系 | 直接抛错 `duplicate data-carry` | 名字在一段内唯一，跨相邻段同名才配对 |
| 光标每个场景各建一个 | 全片**只有一个**光标（`ctx.cursor`），路径按时间排序拼接 | 旧的 `fx.cursor` 是场景内独立光标，不会跨交界 |
| `ctx.cursor` 点一下只是播个动画 | `click: true` **会注入引擎的程序化 click 音**（`engine/carry.js:169`），而且 `press` / `then` 都写在 `if (st.click)` 里面 | 要"零程序化音效"就别用 click：自己 `tl.to(el,{scale:.96})` 做按压 + 自己 `tl.audio()` 排素材音 |
| 只有显式传 `sfx` 才会出声 | `fx.counter` 默认 `sfx:'tick'`、`typewriter` 默认 `'type'`、`scramble` 默认 `'blip'`、`particles` 的 `burst/confetti` 默认 `'success'/'sparkle'` | 不要程序化音效时必须显式 `sfx: null`（`textIn` / `staggerIn` 默认无） |
| 镜头到站就停住 | `camera.drift` 默认 **10px/s**：到站后镜头继续平移，画面元素一直往左飘——用户会指名嫌它 | `camera: { drift: 0 }` 关掉 |
| 缓动只影响观感 | 峰值斜率决定最短时长：`inOutQuad` 2×、`inOutCubic` 3×、**`inOutSine` 1.57×** | 想切得利落就换 `inOutSine`：1920px 只要 1.3s（实测 77px/帧） |
| 给 `<em>` / `<span>` 加个 scale 就行 | **inline 元素不吃 `transform`**，动画静默无效（probe 里它的 transform 始终是 `scale(1,1)`） | 强调词要 `display: inline-block`；"下次再录"那一拍就是这么废掉的 |

**规则**：用任何没亲手用过的 API 前，`grep` 一下引擎源码确认签名；报错信息（`unknown ref` / `unknown envelope` / 未知 blend）会直接抛，**看报错改**。

---

## 2. 版面坑

| 坑 | 根因 | 规则 |
|---|---|---|
| 整章内容跑到画面外 | `position: absolute` 只给了 `top`/`width`，没给 `left`，落到静态位置 | 绝对定位**成对给偏移** |
| 图表柱子和窗口标题栏一起变色 | 单文件只有一份全局 CSS，`.bar` 撞车 | 类名按章节命名空间（`.cbar` / `.code-card > .bar`） |
| 大字号中文被判「裁切」 | CJK 字体的自然行高约 **1.25~1.27em**（104px 的墨迹要 130px），写死 `line-height: 1.2` 就不够，`scrollHeight > clientHeight` | 大标题一律 `line-height: normal`；本次 1827 条「裁切」全是这一个原因 |
| 卡片高度打字时跳动 | `pre` 内容变长撑高容器 | 给 `min-height` 固定住 |
| 浅色底上文字对比度不够 | 灰色正文 / 主色小字 | 正文 ≥4.5:1、大字 ≥3:1；加深颜色或加底 |


---

## 3. 交接与光标的写法

- `data-carry` 两端内容可以不同（例如大标题 → 角落小标签）：几何插值，中间 30% 交叉淡化。两端差太多时看起来像"变形"，最好是同一句话或同一图标。
- carry 飞行时长 = max(转场/镜头时长, 限速时长)。飞行期间目标原件隐藏，所以**不要给目标元素再加入场动画**（会被遮住，白做）。
- 光标点击后用 `then: (ct) => …` 挂结果出现，保证"点了才变"。`press: true` 只对元素目标有效。
- **代价**：`click: true` 会注入引擎的程序化 click 音（`carry.js:169`），`press` / `then` 也挂在它下面。不想要程序化音效就别用 click：自己做 `tl.to(el, { scale: .96 })` 的按压动画 + 自己 `tl.audio()` 排素材音。
- 光标不需要时 `{ hide: t }` 让它退场，下一次移动会自动淡入。末幕可以留它到最后再 `hide`，hide 的那一下也算一次"画面变化"（探针会看到）。


---

## 4. 参数语义

- **`falloff` 的 `rest`**：权重为 0 处的克隆仍保留 `rest` 比例的效果。给 `opacity` 配 `rest: 0.05`，大部分克隆近乎隐形。
- **`distribution.center` 是父容器局部坐标**：面板宽 732 就写 `center: [366, …]`。
- **`pulse` / `step` / `env` 是给音频和数据通道用的**；`link` 到亮度或缩放会变成按拍闪烁，除非你就是想要这个。
- **`counter` 的 `ease` 默认是 `outExpo`**：想要匀速推进，显式写 `ease: 'linear'` 或 `inOutCubic`。
- **`graph` 的 `keys` 有 `loop`**：做"每 4 秒重复"用 `loop: 4`。
- **审计量墨迹不量盒子**：`left:0; right:0` 的居中标题盒子本来就满宽，出画判断用 `Range.getBoundingClientRect()`。

---

## 5. 流程与环境

1. 报错看 `[page error]`，未知 ref / blend / envelope / rhythm 都会明确抛出。
2. `tl.inspect()` 是**构建期**查询，放进每帧回调会拖慢渲染。
3. 导出用 `--workers 4`；24 秒 720 帧约 12 秒渲完（48 秒片约 1 分钟）。
4. 出现 `The browser is already running for …puppeteer_dev_chrome_profile-*`：删掉 `$env:TEMP` 下残留的空 profile 目录再重试。
5. 定稿后 `projects/<name>/` 只留 `index.html`、`out.mp4`、`poster.png`（和 `assets/`），临时 PNG 和没用到的素材清掉。
6. **素材从网上取**：Mixkit 的音效直链可用（抓页面里的 `assets.mixkit.co/active_storage/sfx/...mp3`），Pixabay 对脚本返回 403；BGM 用 archive.org 的 Free Music Archive 集合（`advancedsearch.php?q=collection:(freemusicarchive)` 找条目 → `/metadata/<id>` 列文件 → `/download/<id>/<file>` 下载）。
7. **要沿用上一次会话的上下文**（旧的生图网关配置、已生成的素材）：`.dsh/sessions/**/session.v3.jsonl.zstd` 是**多帧 zstd**，`zstdDecompressSync` 只解第一帧，得按 magic `28 b5 2f fd` 切帧逐个解（Node 24 自带 zstd）。生图走 `tools/gen-image.mjs` + `OPENAI_BASE_URL` / `IMAGE_MODEL` 环境变量。

---

## 6. 工具能告诉你什么

- **`audit`**：只量 **DOM 文字**。只有**裁切、出画、页面报错**算阻塞（退出码 1），这三样是客观上坏掉了。压叠、空帧、偏空、静止、对比度、镜头速度、rhythm、交接、色号/字号都只是**读数**：告诉你画面里发生了什么，由你按这一支片子的原则判断要不要改。全部画在 canvas 上的片子没有 DOM 文字，空帧/偏空读数没有意义。
- **`pacing`**：量每章"最后一拍 → 章末"空了多久，只输出读数，不判对错。教程里空等 5 秒通常是拖沓；MV 里同样的 5 秒可能是故意的留白。
- **运动能量**：`ffmpeg -i out.mp4 -vf "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null -`。和参考视频用同一条命令量，比较的是数字，不是感觉。
- `--step 0.2` 偶尔报「偏空」、`--step 0.1` 没有：采样步长的边界效应，以 0.1 为准。

---

## 7. 历史项目备注（参考，不是约束）

这些是具体某支片子里用户的原话和当时的结论。新片子遇到类似情境可以参考，但**不要默认套用**；和当前片子的参考或用户要求冲突时，以当前为准。

| 片子类型 | 用户原话 | 当时的处理 |
|---|---|---|
| 产品宣传（连续模式） | "画面效果还是太简单了，根本无法和PPT相区分" | 交界处让元素延续（`data-carry` / 光标），背景层持续运动 |
| 产品宣传 | "页面元素总是在往左边飘移，不要这个效果" | `camera: { drift: 0 }` |
| 产品宣传 | "你为什么那么喜欢用呼吸特效呢？…一闪一闪，并不好看" | 去掉 pulse 驱动的整屏亮度 |
| 产品宣传 | "以及奇怪的震动，这个也不要" | 去掉标题 shake 和卡片 float |
| 产品宣传 | "开场的字母糊在一起了" | 大字号不用逐字 blur，改整行入场 |
| 产品宣传 | "单个帧结束后，停留时间应该控制在 0.5s 以内" / "最后一幕停留时间应该延长" | 每章演完就切，末幕留 2~3s |
| 产品宣传 | "一些该停顿留白的部分没有留白，导致阅读不过来" | 列表 0.4~0.55s 一行，落完停 2~4s |
| 产品宣传 | "去掉很多没有必要的庆祝等音效…一个 BGM 和简单的点击音很够" | 只留 BGM + 点击音，引擎默认音效全部 `sfx: null` |
| B 站风宣传 | "不应该是有很多弹幕的所谓 Bili 风格" | 0 条弹幕，风格靠配色和版式 |
| DSH 插件介绍 | "你必须仔细思考这个插件的真正用途" | 先定一句话卖点，再排分镜 |
| DSH 插件介绍 | 要求加"本视频由 … 生成"署名 | 只在那支片子加了；**别的片子用户明确不要提工具** |
| 动画 PV（mikazuki） | "有些部分过于流畅了…应该用动态模糊，疾走感（前几帧慢，后几帧快速跳到结果）" | 句内缓慢滑动蓄势，换句时 2~3 帧甩到下一构图并带真实拖影 |
| 动画 PV | "你画的SVG过于丑了" | 去掉具象小人和道具，改纯几何 |
