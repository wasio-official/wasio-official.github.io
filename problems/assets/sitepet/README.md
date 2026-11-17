# 站点虚拟助手（Live2D 看板娘）· 集成说明

本目录是为 wasio 站点制作的 Live2D 看板娘，
目前功能包括全站连贯导览、台词气泡、找题入口、反馈入口。

目前模型为免费的**桃濑日和**模型（没错就是Neuro的旧模型）。理论上设计了换模型的接口，尚未尝试。

**导览功能**由第一个按钮触发，能够依次介绍站点目前的七个页面，文案在 `tour.json`。设计有从中间继续的功能。介绍时会屏蔽其他点击事件。

**台词气泡**目前主要设计为对于当前页面的介绍，点击模型可以触发，文案在 `lines.json`。台词比较人机。

**找题入口**是第二个按键，点击后弹出气泡，其中可以点击选项以到达对应的考点搜索界面。多数页面点击后弹出的是随机的“考点+难度”组合；在具体题目页面会弹出”找同类题“的选项。
原本设计是个性化推荐题目，不过已放弃。

**反馈入口**与网站原有的反馈按键作用相同，不保证没有BUG，所以要不要替换我不好说。

最后一个按键可以**关闭模型形象**。开启与关闭状态会记录，在下次打开时读取。

主要在PC端进行测试，尽量让人物模型和按键不挡住已有按键，模型点击判定范围缩小到接近人物本身范围。
为窄屏做了缩小模型的适配，且自动不会出现。不保证视觉效果好。且有显著的位置BUG，不是很想修（关掉重新打开就好了）。

其中尝试做了AI接口，尚未接入，感觉也不会需要了……

后面是DS写的，随便看看吧。
---

本说明只描述**本 PR 实际包含的文件与行为**，供维护者审阅、运行与后续维护使用；
功能的设计依据见文末「设计文档」。

---

## 1. 这个 PR 做了什么

### 1.1 接入的页面

在 `problems/` 下的 **7 个页面**的 `</body>` 前各新增 **3 行**（2 行注释 + 1 行 module script）：

```html
<!-- 网站宠物：可选功能，删掉下面这两行即可完全移除。
     它不修改、也不依赖上面任何脚本，只在空闲时加载自己的立绘与文案。 -->
<script type="module" src="assets/sitepet/pet.js"></script>
```

| 页面 | 路径 |
|---|---|
| 落地页 | `problems/index.html` |
| 题库 | `problems/library.html` |
| 试卷 | `problems/paper.html` |
| 单题 | `problems/question.html` |
| 网页出卷 | `problems/pdfgen.html` |
| 考点导航 | `problems/tags.html` |
| 投稿 | `problems/submit.html` |

仓库根目录的跳转壳（`index.html` / `library.html` / `paper.html` / `pdfgen.html` / `404.html`）不接线。

### 1.2 新增的目录

本 PR 新增 `problems/assets/sitepet/` 目录（本目录），包含看板娘的预构建资源、模型与数据。
**没有修改任何现有 js/css，也没有改站点数据文件。**

---

## 2. 目录内容

| 路径 | 说明 |
|---|---|
| `pet.js` | 看板娘引擎 + wasio 适配器的构建产物；页面通过上面的 script 标签加载 |
| `runtime.js` | Live2D 运行时，独立分包；页面空闲时才动态加载 |
| `models.json` | 模型注册表：默认模型、路径、缩放、位置、降级静态图、出处 |
| `tour.json` | 全站连贯导览的段与步骤（标题、目标选择器、文案） |
| `lines.json` | 人设与台词：`character` + 按场景分组的 `lines` |
| `models/hiyori/` | Hiyori 模型：`Hiyori.model3.json`、`Hiyori.moc3`、`Hiyori.cdi3.json`、`Hiyori.physics3.json`、`Hiyori.pose3.json`、`Hiyori.userdata3.json`、两张贴图、`motions/Hiyori_m01~m10.motion3.json`（共 18 个模型文件）与 `LICENSE-NOTICE.md` |
| `README.md` | 本说明 |

`pet.js` / `runtime.js` 是预构建产物；上游站点是纯静态站，**使用本目录不需要 Node/Vite 构建**。
引擎源码、构建配置与设计文档不在本 PR 中。

---

## 3. 运行方式

站点本身是纯静态的。在仓库根目录起一个 http 服务即可：

```bash
python -m http.server 8099
```

然后打开：

```text
http://127.0.0.1:8099/problems/index.html
```

- 必须走 http：模型与 JSON 通过 `fetch` 加载，`file://` 会因 CORS 失败。
- 不需要改任何构建配置，也不需要安装依赖。
- 首次进站**不会自动开始导览**，只会用一句提示告诉访客「点它可以看功能介绍」。

---

## 4. 功能

### 4.1 宠物本体（装饰 + 台词）

- Hiyori 停在右下角；桌面舞台 300×420，窄屏 180×240。
- 点击立绘会说话；气泡自研，带逐字打字效果，不使用渲染库自带的 tips。
- 控制条为 4 个按钮（`导览 / 找题 / 反馈 / 关闭`）；`index` 与 `pdfgen` 两页没有站点反馈入口，
  所以这两页只显示 3 个按钮（无「反馈」）。
- 控制条触控区 48px（窄屏 44px）；UI 全部在 Shadow DOM 内，与宿主站点样式隔离；
  会继承站点自己的 CSS 变量（`--bg` / `--ink` / `--accent` 等），每个变量都有兜底值。
- 台词调性为「极简工具人」：只在用户点它、或明确卡住时说话；没有 idle 闲聊。
  仅在两种明确卡住的情况下主动提示：考点页 45 秒无选择、搜索结果为 0。
- 关闭后写 `localStorage`，刷新不再出现，只剩一个「召唤宠物」按钮；点它可恢复。
- 站点自己的反馈遮罩打开时，宠物气泡与控制条会自动淡出，不浮在模态之上。

### 4.2 找题助手

点「找题」（或点立绘后点「找题」）会在气泡里给出找题入口：

- 从 **`qmeta.json` + `papers.json`** 推导一级考点与文字难度四档（`简单 / 中等 / 中上 / 较难`），
  **不拉 `tags.json`（约 1.6 MB）**。
- 默认给出 2 条「一级考点 + 难度档」组合；组合只从**至少命中 1 题**的交叉里抽取，
  不会把用户送到空结果页。
- 点按钮直接跳到 `tags.html` 的筛选结果（`t=` 与 `dt=` 参数）。
- 点过的组合会写入浏览器 `localStorage`，下次置顶显示「（上次）」；可一键清除。
- 在单题页，优先给出 4 条「搜同类题」：用当前题第一条考点路径，依次截到四级 / 三级 / 二级 / 一级，
  难度锁当前题的档位；点任意一条落到 `tags.html` 的对应筛选。

### 4.3 全站连贯导览

点控制条「导览」开始，按以下顺序跨页讲解：

```text
index → library → paper → question → pdfgen → tags → submit
```

- 当前 `tour.json` 共 **7 段 12 步**（每段 2/2/2/2/2/1/1 步）。
- 每一步：高亮目标元素（支持逗号分隔的多个选择器，取并集外框）+ 气泡讲解。
  气泡文字是「强调模式」：15px / 600 字重、强调色浅底、左侧 3px 强调色边条。
- **点页面任意处 = 下一步**；每一步气泡下方有「点击任意位置以继续」，最后一步不显示。
- 段末点一下跳到下一页并续上；导览进度写 `localStorage`，中途退出后可「接着上次」继续。
- **导览期间屏蔽站点自己的点击**（捕获阶段 `preventDefault + stopPropagation`），避免点试卷卡片 /
  随机抽卷 / 生成 PDF 时把页面带走；宠物自己的按钮（含「退出导览」）不受影响。
- 窄屏默认收起，但**导览正在本页进行时自动展开**，保证跨页接力不中断。
- 导览高亮目标在异步渲染的页面上会等待（MutationObserver + 6 秒上限）；`optional` 步骤等不到目标时跳过，
  不会卡在找不到元素的高亮上。

### 4.4 反馈

- 看板娘**不自建反馈面板**，而是委托站点自己的反馈入口：
  - `library` / `tags` / `paper` / `question` 四页：触发站点右下角的 `#fb-fab`，由站点自己的
    `feedback.js` 负责表单与上下文；
  - `submit` 页：打开站点配置里的投稿表单（`FEEDBACK_CONFIG.submitFormUrl`）；
  - `index` / `pdfgen`：站点没有反馈入口，所以控制条不显示「反馈」按钮。
- 看板娘不收集、不上传反馈内容；站点表单是否可用取决于站点自己的配置。

### 4.5 窄屏、关闭与降级

- 窄屏（≤768px）默认只留一个 44×44 的「展开站点助手」小按钮，点开才加载立绘；
  导览进行中例外，会自动展开。
- 关闭状态写 `localStorage`；刷新后只剩「召唤宠物」，不加载模型。
- 降级链（按顺序，命中即停）：
  1. `prefers-reduced-motion: reduce` → 静态立绘（`fallbackImage`），无 canvas、无定时台词；
  2. 无 WebGL → 同上；
  3. 用户上次关掉了宠物 → 只显示「召唤宠物」按钮，完全不加载模型；
  4. 模型加载失败 → 可见错误卡 + 重试按钮，不静默吞错。
- 不影响首屏：运行时用动态 `import()` + `requestIdleCallback` 挂载；宠物宿主都是 `position: fixed`，
  挂载前后文档高度不变（CLS = 0）。
- **零外部请求**：运行时与模型全部自托管；渲染库上游的版本检查与「一言」请求已在本引擎内被掐断。

---

## 5. 配置（改 JSON 即可，不需要重新构建 js）

本目录的三个 JSON 是运行时读取的；改完刷新页面即生效：

### 5.1 `models.json`

模型注册表。字段：

| 字段 | 含义 |
|---|---|
| `default` | 默认模型 id |
| `id` / `name` / `source` | 标识、显示名、出处（会显示在换人面板里） |
| `path` | `model3.json` 的相对路径 |
| `fallbackImage` | reduced-motion / 无 WebGL 时的静态立绘图 |
| `scale` / `mobileScale` | 桌面 / 窄屏的模型缩放 |
| `position` / `mobilePosition` | 立绘在舞台画布内的平移（用于把人往右挪，不移动气泡） |

### 5.2 `tour.json`

导览的**纯数据**：

- `order`：段的顺序（当前 7 段）；
- `segments.<id>.title` / `url`：段标题与入口；
- `steps[]`：`target`（CSS 选择器，可逗号分隔）、`text`（气泡文案）、
  `optional: true`（等不到目标时跳过）、`resolve`（paper / question 段运行时挑卷）。

改步骤、改顺序、改文案都只动这个文件，不需要改代码；段数与每段步数也是数据驱动的。

### 5.3 `lines.json`

- `character`：名字与人设；
- `lines`：按场景分组的台词（如 `hint`、`pageHelp.*`、`tagsIdle`、`searchEmpty`、
  `finderOffer`、`finderNoScale`、`tourStart`、`tourDone`、`tourExit`、
  `feedbackDelegated`、`feedbackUnavailable`、`modelSwitched`、`loadError`）。

### 5.4 调试接口

挂载完成后 `window.SitePet` 可用，并派发一次 `sitepet:ready` 事件。常用方法：

```js
SitePet.say('文本', { priority: 2 });     // 主动说一句
SitePet.sayScene('pageHelp.tags');        // 按场景随机说一句
SitePet.setLines('tap', ['新台词']);       // 热替换某场景
SitePet.listModels(); SitePet.currentModel();
SitePet.switchModel('hiyori');
SitePet.openModelPanel();                 // 站长换人面板（不占控制条）
SitePet.sleep(); SitePet.wake(); await SitePet.destroy();
```

`openModelPanel()` 是站长能力（默认不在访客控制条里），用于换模型 / URL 导入，
自定义模型只存浏览器 `localStorage`，不写入仓库。

---

## 6. 本地验证清单

1. 仓库根目录 `python -m http.server 8099`，打开 `/problems/index.html`。
2. 右下角出现 Hiyori；点立绘会说话；控制条 4 个按钮（index 页 3 个，无反馈）。
3. 点「导览」：按 index → library → paper → question → pdfgen → tags → submit 走完；
   点页面任意处推进；段末跳页后续上；点「退出导览」可中止并保留进度。
4. 点「找题」：出现组合按钮；点一条落到 `tags.html` 并回填筛选；再点「找题」看预设是否置顶。
5. 打开 `question.html?p=<slug>&q=<n>`，点「找题」应出现 4 条「搜同类题」。
6. 点「反馈」：应打开站点自己的反馈面板（submit 页为投稿表单；index/pdfgen 无此按钮）。
7. 点「关闭」：立绘消失；刷新只剩「召唤宠物」；点它恢复。
8. 窄屏（DevTools 设备模式 ≤768px）：默认只有小按钮；展开后立绘缩小；导览进行中自动展开。
9. 控制台执行 `SitePet` 应存在；`window` 上应收到一次 `sitepet:ready`。
10. Network 面板：看板娘不产生新的外部请求；模型、JSON、运行时都来自本站。

> 说明：单题页的 `#p-analysis` / `#p-answer` 依赖题目数据渲染；导览对应步骤标了 `optional`，
> 数据未就绪时会跳过该步，不会中断整段。

---

## 7. 如何完全移除

1. 从 7 个页面删除第 1.1 节那 3 行（注释 + `<script>`）。
2. 删除 `problems/assets/sitepet/` 整个目录。
3. 没有其他引用；不需要改任何现有 js/css，也不需要清理站点数据。

---

## 8. 兼容性与已知限制

- **没有视线跟随与口型同步**：当前渲染库 `oh-my-live2d` 不对外暴露参数读写接口，做不了。
- **默认静音**（`volume: 0`），动作里的音频不会自动播放。
- 运行时内置 **Cubism Core 5.0.0**，可读 `moc3` 版本 ≤ 5；用 Cubism 5.3 导出的 ver 6 模型加载不了，
  需要把导出版本降到 5.0。
- **立绘舞台会覆盖右下角页面内容**：桌面 300×420、窄屏 180×240，画布必须可点（点立绘说话），
  因此该区域内的站点控件可能点不到。这是已知取舍；站点自己的右下反馈 FAB 通过整体抬升 76px 避开。
- **反馈面板没有看板娘后端**：只负责唤起站点现有入口，不保存反馈。
- **换人面板是站长能力**：默认不在访客控制条里，通过 `SitePet.openModelPanel()` 打开。
- 导览高亮跟随滚动是 rAF 节流的，元素位置突变时有 250ms 过渡；异步目标最多等 6 秒。

---

## 9. 素材与授权（合并前请确认）

### 9.1 Hiyori 模型

- 来源：Live2D 官方免费示例素材，取自
  [`Live2D/CubismWebSamples`](https://github.com/Live2D/CubismWebSamples) 的
  `Samples/Resources/Hiyori/`；共 18 个模型文件（约 4.8 MB）。
- 详细出处、文件清单与条款链接见本目录的
  [`models/hiyori/LICENSE-NOTICE.md`](models/hiyori/LICENSE-NOTICE.md)。
- 条款要点（以 Live2D 官网原文为准）：
  - 一般用户与年销售额低于 1000 万日元的小规模企业，可自由用于商业与非商业创作；
  - Unity-chan（大鸟こはく）与初音未来不适用该授权；本项目未使用这两个角色；
  - 不得用于色情、暴力，或可能使观众误解角色形象、感到不适的表达。

### 9.2 渲染运行时与 Cubism Core

- 渲染库为 `oh-my-live2d`（MIT），其内置 **Live2D Cubism Core** 遵循
  **Live2D Proprietary Software License**（不是 MIT），与库主体的 MIT 许可独立。
- 年销售额达到或超过 **1000 万日元**的事业者，需另行取得
  [Cubism SDK Release License](https://www.live2d.com/en/download/cubism-sdk/release-license/)。
- `LICENSE-NOTICE.md` 是模型目录自带的素材说明；Cubism Core 的最终授权以 Live2D 官方条款为准。

---

## 10. 设计文档

本目录的行为与限制来自以下设计文档（位于引擎工程 `docs/superpowers/specs/`，不在本仓库）：

| 文档 | 内容 |
|---|---|
| `2026-11-15-website-pet-design.md` | 通用看板娘引擎：架构、降级链、无障碍、已知限制 |
| `2026-11-15-wasio-pet-integration-design.md` | 本集成：7 页接线、连贯导览、反馈委托、视觉与避让、验收记录 |
| `2026-11-16-wasio-finder-preset-design.md` | 找题助手：随机考点+难度组合、预设、单题页「搜同类题」 |

本说明只摘录与本 PR 直接相关的部分；完整规则、实测记录与历史取舍以设计文档为准。
