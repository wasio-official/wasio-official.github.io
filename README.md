# 物理竞赛题库 · 展示站

高中物理竞赛试卷与题目的在线题库，配套 GitHub Pages 静态站点。

**线上地址**：<https://wasio-official.github.io/>

---

## 站点结构

**首页与题库功能分离**：首页只作落地页（简介 + 统计 + 入口），
搜索与试卷浏览集中在独立的题库页。

| 页面 | 地址 | 内容 |
|------|------|------|
| 首页（落地页） | `/index.html` | 标题、简介、总览统计、两个入口按钮 |
| 题库 | `/library.html` | 试卷目录、搜索 / 类型 / 排序筛选 |
| 试卷页 | `/paper.html?id=<试卷slug>` | 该卷题目列表（**仅题号 + 难度 + 考点标签**） |
| 单题页 | `/question.html?p=<试卷slug>&q=<题号>` | 题干、详细解析、答案、11 维度难度评分 |

交互要点：

- **试卷页题目列表只显示标签**，不显示题干摘要，便于快速扫读考点。
- 题库页与试卷页都支持搜索：题库页按试卷名 / 考点标签，试卷页按题号 / 考点标签。
- **解析与答案默认折叠**，点击标题展开；右上角「显示全部」一键展开/收起。
- 公式用 **MathJax** 渲染，图片懒加载。
- 单题页支持键盘 `←` `→` 切换上一题 / 下一题。
- 响应式布局，手机 / iPad 可用。

## 技术栈

零依赖纯静态：原生 HTML + CSS + JavaScript，无需构建工具链或服务器。
数据在构建时预生成为 JSON，前端 `fetch` 后按需渲染。

```
wasio-official.github.io/
├── index.html                 落地页
├── library.html               题库页（搜索 / 筛选）
├── paper.html                 试卷页
├── question.html              单题页
├── assets/
│   ├── app.css        全部样式
│   ├── app.js         公共：数据加载、Markdown→HTML、MathJax、折叠面板
│   ├── landing.js     落地页逻辑（只取统计）
│   ├── library.js     题库页逻辑
│   ├── paper.js       试卷页逻辑
│   └── question.js    单题页逻辑
└── data/
    ├── papers.json          试卷索引（名称/slug/题数/分类/难度分布/标签）
    ├── papers/<slug>.json   逐卷题目数据
    └── images/<slug>/       题目配图（从源目录复制）
```

## 数据来源

内容来自 `D:\Wasio\Workspace\output\`（PhO 项目的题目归档），
每道题是一个 Markdown 文件，结构统一：

```markdown
---
tags: [力学/刚体转动/...]
difficulty: 中等
question_id: 1
paper_name: 2025爱培优一
difficulty_score: {"D":"5-6","A1":"4",...,"note":"关键步是..."}
---

## 题目内容
...
## 详细解析
...
## 答案
...
```

图片以 `![](images/xxx.jpg)` 相对路径引用，构建时统一重写为 `data/images/<slug>/xxx.jpg`。

## 构建

```bash
# 全量构建（220 套 / 约 2089 题）
python build.py

# 只构建指定试卷（小样抽查 / 增量）
python build.py --papers "2025爱培优一,第42届全国中学生物理竞赛复赛理论试题"

# 只构建前 N 套
python build.py --limit 3
```

`build.py` 会清空并重建 `data/papers/` 与 `data/images/`，然后写入 `data/papers.json`。
构建产物直接位于仓库内，**建议连同 `data/` 一起提交**（GitHub Pages 只托管提交的文件）。

## 本地预览

```bash
cd wasio-official.github.io
python -m http.server 8099
# 浏览器打开 http://127.0.0.1:8099/
```

> 必须用 HTTP 服务打开，直接双击 `index.html`（`file://`）会因浏览器 CORS 限制无法加载 JSON。
> 本地服务器根目录必须是仓库目录（即 `wasio-official.github.io/`），
> 因为 `data/` 与 `assets/` 都按「相对仓库根」的路径引用。

## 标签展示控制（预留）

站点有**两套彼此独立**的标签，都在数据里留好了位置，当前内容为空、不影响显示。

### 一、题目标签（已在用）

题目自带 `tags`（如 `力学/刚体转动/转动定律/转动惯量`），展示规则集中在
`assets/app.js` 顶部的 `TAGS_CONFIG`：

```js
const TAGS_CONFIG = {
  mode: "leaf",        // "leaf" 末级 | "full" 完整路径 | "field" 用新字段
  field: "tag_display",// mode === "field" 时取哪个字段
  max: 0,              // 展示上限，0 = 不限
  tooltip: "full",     // 悬浮提示用完整路径
};
```

改 `mode` 一行即可全站切换（试卷页题目列表、单题页一起生效）。
当前 `leaf` 模式显示路径末级，如 `力学/刚体转动/转动定律/转动惯量` → `转动惯量`。

### 二、试卷标签（预留，当前为空）

`data/papers.json` 里每套试卷都带一个 `tags` 字段，**当前一律为空数组**，
因此题库页卡片上**不显示任何标签，也不会渲染空的标签行**。

- 渲染控制：`assets/app.js` 的 `PAPER_TAGS_CONFIG`（`max` 显示上限、`search` 是否参与检索）。
- 数据来源：`build.py` 的 `_paper_tags()`。它优先读取试卷目录下的
  `paper.yaml` / `_paper.yaml`（写 `tags:` 列表即可）；没有该文件就返回空。
- 列表卡片、搜索都会自动适配 —— 数据一旦有值，标签自动出现，**无需改页面脚本**。

> 说明：历史上卡片标签是从题目标签聚合出来的（`_top_tags`），已按要求改为留空。
> 如需恢复旧行为，把 `_paper_tags()` 末尾 `return []` 换成其上方注释的
> `return _top_tags(questions, 8)` 即可。
> 注意这会让「搜索命中数变多」（试卷标签也参与检索），属预期差异。

### 标签同时支持两种形态

**字符串**与**对象**都可以，对象形如
`{ path: "力学/…/转动惯量", tag_display: "转动惯量" }`，前端两种都能渲染。

## 当前进度

**全量已上线：220 套试卷 / 2089 题 / 3665 张配图**（仓库约 66 MB）。

题型覆盖：模拟/联考 69、难题集萃 38、其它 37、决赛 24、实验 20、题选 17、复赛/预赛 15。

构建耗时约 1–2 分钟（主要是复制 3665 张图片）。增量更新：

```bash
python build.py                                   # 全量重建
python build.py --papers "2025爱培优一,量子第一套"   # 只重建指定试卷
```

> 注意：`build.py` 会**清空并重建** `data/papers/` 与 `data/images/`，
> 因此不能只跑单套就推送 —— 那样会把其余试卷从站点里删掉。
> 只想更新个别试卷时，重建后请确认 `data/papers.json` 仍是全量 220 套。

## 已知事项

- 图片带有 `loading="lazy"`，折叠区内或视口外的图片在展开 / 滚动时才加载，属预期行为。
- 少部分来源试卷本身内容很短（如第一届 OPhO 部分题），解析短是源数据如此，非解析丢失。
- 站点内容为个人整理的竞赛资料，仅供学习交流。
