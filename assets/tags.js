/* ============================================================
   考点导航页：四级考点级联筛选 + 难度范围筛选 + 关键词检索 + 跨卷题目汇总

   数据：data/tags.json
     tree   四级考点树，节点 { name, n, c }
     index  完整路径（用 "/" 连接）→ 题目引用数组 [ [slug, 题号], ... ]
            每一级路径在 index 里都有条目，因此「选到哪一级就按
            哪一级汇总」天然成立。
     papers 试卷 slug → 试卷显示名
     stats  { tags, questions }
     difficulty { min, max, step, unit, labels, values, hist, unlabeled }
            难度刻度元数据：values 是全部可选刻度（字符串，排序即大小顺序），
            labels 是刻度 → 显示名（如 1 → 简单），hist 是刻度 → 题数。

   ⚠️ 难点：难度数值 difficulty_value 只存在于单题 JSON（data/papers/<slug>.json），
   tags.json 的 index 里只有 [slug, 题号]，**没有难度**。
   因此难度筛选必须在 fetchItems() 拉到详情之后才能做 —— 这直接影响
   MAX_RENDER 的截断时机：先截前 300 条再按难度过滤会漏掉本应命中的题。

   标签展示规则统一由 app.js 的 renderTags / TAGS_CONFIG 控制，
   本文件不重复实现标签渲染。
   ============================================================ */

/** 结果列表最多渲染多少条（超出的只提示、不渲染） */
const MAX_RENDER = 300;

/** 批量抓取试卷 JSON 时的并发上限 */
const FETCH_CONCURRENCY = 8;

/** 级联层数（与数据里的 levels 保持一致） */
const LEVELS = 4;

/** 未选考点、也没搜索时的引导文案 */
const GUIDE_HTML = `
  <div class="empty">
    <strong>请先选择考点</strong>
    在上方四个下拉框里从「一级考点」开始逐级收窄，<br>
    或直接用搜索框检索考点名称、试卷名；<br>
    <span class="empty-tip">选好范围后，还可以再用「难度」把结果收窄到某个区间。</span>
  </div>`;

const state = {
  tree: [],            // 四级考点树
  index: {},           // 路径 → 题目引用数组 [ [slug, 题号], ... ]
  nameMap: {},         // 试卷 slug → 试卷显示名（优先用 tags.json 的 papers）
  paperLoad: {},       // 试卷 slug → Promise（增量加载题干/标签，做缓存）

  path: [],            // 当前选中的考点路径，如 ["力学", "刚体转动"]
  q: "",               // 搜索关键词

  // 难度刻度元数据（来自 tags.json 的 difficulty），未加载前给一份保守默认值
  diff: { values: [], labels: {}, hist: {}, unit: "", texts: [], text_hist: {} },
  dmin: "",            // 数值难度 D 下限（"" = 不限），字符串刻度
  dmax: "",            // 数值难度 D 上限（"" = 不限），字符串刻度
  dtext: "",           // 文字档位（简单/中等/中上/较难），"" = 不限

  // 搜索索引：全部题目的扁平清单（含路径 / 试卷名 / 检索串）
  items: null,

  // 拼音数据（来自 tags.json 的 pinyin）：{chars, segs}，供模糊搜索用。
  // 缺失时（旧版 tags.json）模糊搜索自动退化为纯子串匹配，不报错。
  pinyin: { chars: {}, segs: {} },

  // 请求序号：用于丢弃「用户已改选择后才返回」的过期结果
  seq: 0,
};

/* ---------------------------------------------- 基础工具 */

/** 按当前选中路径取题目引用（未选考点则为空数组） */
function chosenRefs() {
  if (!state.path.length) return [];
  return state.index[state.path.join("/")] || [];
}

/** 试卷显示名：优先查 papers 映射表，再回退到已加载的试卷目录 */
function paperName(slug) {
  return state.nameMap[slug] || slug;
}

/** 题目引用的唯一键 */
function refKey(slug, qid) {
  return `${slug}#${qid}`;
}

/* ---------------------------------------------- 难度刻度工具

   刻度一律当字符串处理：values 的顺序即大小顺序，比较用「下标」而不是数字，
   这样即使将来刻度变成 "A"/"B" 或 "1.5"/"2.5" 也不会错。
   difficulty_value 为 null（未标注）的题在启用任一难度边界时一律被排除。 */

/** 取某个刻度在 values 里的下标；非法/空值返回 -1 */
function diffRank(v) {
  if (v === "" || v === null || v === undefined) return -1;
  return state.diff.values.indexOf(String(v));
}

/** 难度刻度是否已启用（至少选了一个边界，且该边界是合法刻度） */
function diffActive() {
  return selectedMin() !== "" || selectedMax() !== "";
}

/** 实际生效的下限（非法值当作不限）；与 selectedMax 配合做 min>max 纠正 */
function selectedMin() {
  return diffRank(state.dmin) >= 0 ? String(state.dmin) : "";
}

/** 实际生效的上限（非法值当作不限） */
function selectedMax() {
  return diffRank(state.dmax) >= 0 ? String(state.dmax) : "";
}

/**
 * 把上下限纠正成合法顺序：min > max 时把 max 抬到 min，
 * 不报错也不卡住（用户先选大上限、再改小下限时不会莫名其妙空结果）。
 */
function normalizeDiffRange() {
  const a = diffRank(state.dmin);
  const b = diffRank(state.dmax);
  if (a >= 0 && b >= 0 && a > b) {
    state.dmax = state.dmin;
    syncDiffSelects();
  }
}

/**
 * 单个难度值是否命中当前区间。
 * 未启用难度时恒为 true；难度值缺失/不在刻度表内一律视为不命中。
 */
function diffMatch(v) {
  if (!diffActive()) return true;
  if (v === null || v === undefined || v === "") return false;
  const r = diffRank(v);
  if (r < 0) return false;
  const lo = diffRank(selectedMin());
  const hi = diffRank(selectedMax());
  if (lo >= 0 && r < lo) return false;
  if (hi >= 0 && r > hi) return false;
  return true;
}

/**
 * 难度过滤：未启用难度时原样返回（保持默认路径零开销）。
 * @param {Array} items 已带 difficulty_value 的题目条目
 */
function filterByDifficulty(items) {
  if (!diffActive()) return items;
  return items.filter((it) => diffMatch(it.difficulty_value));
}

/* ---- 第二套维度：文字档位（difficulty）----
   与数值 D 相互独立，可同时使用（交集）。

   引用里的文字档位只存序号（1-based），这里用 state.diff.texts 还原成文字，
   避免 6000+ 条引用逐条内联中文。 */

/** 文字档位是否启用 */
function textActive() {
  return !!state.dtext && (state.diff.texts || []).includes(state.dtext);
}

/** 序号（引用第 4 位）→ 文字档位 */
function textOfCode(code) {
  const texts = state.diff.texts || [];
  const i = Number(code) - 1;
  return i >= 0 && i < texts.length ? texts[i] : "";
}

/** 单个文字档位是否命中当前选择 */
function textMatch(text) {
  if (!textActive()) return true;
  return text === state.dtext;
}

/** 结果行里的文字档位描述 */
function diffTextPhrase() {
  return textActive() ? `档次 ${state.dtext}` : "";
}

/** 刻度的显示文本：有 label 用「简单 1」，没有就纯数字 */
function diffLabel(v) {
  const s = String(v);
  const name = state.diff.labels ? state.diff.labels[s] : "";
  const unit = state.diff.unit ? String(state.diff.unit) : "";
  if (name) return `${name} ${s}${unit}`;
  return `${s}${unit}`;
}

/** 选项文本：尽量带上题数，形如「简单 1（243）」 */
function diffOptionText(v) {
  const base = diffLabel(v);
  const hist = state.diff.hist || {};
  const raw = hist[String(v)];
  if (raw === undefined || raw === null || raw === "") return base;
  return Number.isFinite(Number(raw)) ? `${base}（${raw}）` : base;
}

/** 结果行里的难度描述：全区间 / ≥x / ≤x / x–y */
function diffPhrase() {
  const lo = selectedMin();
  const hi = selectedMax();
  const loRank = diffRank(lo);
  const hiRank = diffRank(hi);

  let phrase = "";
  if (loRank >= 0 && hiRank >= 0) {
    // 单点区间写成「难度 2」，比「难度 2–2」自然
    phrase = lo === hi ? `难度 ${diffLabel(lo)}` : `难度 ${diffLabel(lo)}–${diffLabel(hi)}`;
  } else if (loRank >= 0) {
    phrase = `难度 ≥${diffLabel(lo)}`;
  } else if (hiRank >= 0) {
    phrase = `难度 ≤${diffLabel(hi)}`;
  }

  // 两套维度可同时生效，拼成「难度 5–7、档次 中上」
  const t = diffTextPhrase();
  if (phrase && t) return `${phrase}、${t}`;
  return phrase || t;
}

/** 路径 → 可点击的层级面包屑（层级为从深到浅的索引，如 [2, 1, 0]） */
function show(crumbs) {
  const el = document.getElementById("crumb-path");
  if (!crumbs.length) {
    el.innerHTML = "";
    return;
  }
  const parts = crumbs
    .map((i) => `<button type="button" class="crumb-step" data-i="${i}">${esc(state.path[i])}</button>`)
    .join(`<span class="crumb-sep">›</span>`);
  el.innerHTML = `<span class="crumb-label">当前考点</span>${parts}`;
}

/** 把题目引用数组去重（同一题在多个标签下可能重复出现）
    引用格式是 [slug, 题号, 数值难度D?, 文字档位序号?]（后两项可能缺省），
    去重时要把两个难度一起带上，否则难度筛选会拿不到值。 */
function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const slug = r[0], qid = r[1];
    const key = refKey(slug, qid);
    if (seen.has(key)) continue;
    seen.add(key);
    const copy = [slug, qid];
    if (r.length > 2) copy.push(r[2]);
    if (r.length > 3) copy.push(r[3]);
    out.push(copy);
  }
  return out;
}

/* ---------------------------------------------- 题目条目渲染
   视觉结构对齐 paper.js 的 questionItem，额外加一枚试卷名 chip。 */

function questionItem(it) {
  const tags = renderTags(it.tags, { empty: "未标注考点" });
  // 外层是 <a>，内部不能再嵌套 <a>，因此试卷名只作为 chip 文本展示
  const paper = it.paper ? `<span class="chip chip-cat">${esc(it.paper)}</span>` : "";

  // 复选框与链接并排（结构同 paper.js），避免嵌在 <a> 里导致
  // 点勾选就跳走。psCheckbox 由 paperset.js 提供。
  const box = typeof psCheckbox === "function" ? psCheckbox(it.p, it.q) : "";

  return `
    <div class="q-row">
    ${box}
    <a class="q-link" href="question.html?p=${encodeURIComponent(it.p)}&q=${encodeURIComponent(it.q)}">
      <span class="q-num">${esc(it.num)}</span>
      <span class="q-body">
        <span class="q-title-row">
          ${paper}
          <span class="q-title">${esc(it.title)}</span>
          ${difficultyChip(it.difficulty)}
        </span>
        <span class="q-tags">${tags}</span>
      </span>
      <span class="q-arrow">›</span>
    </a>
    </div>`;
}

/** 隐藏用的占位模板（MathJax 不存在时用于跳过公式排版） */

/* ---------------------------------------------- 结果渲染 */

/**
 * 渲染题目列表。
 * @param {Array} items 已就绪的题目条目（含 title / tags / difficulty）
 */
function renderList(items) {
  const list = document.getElementById("q-list");

  if (!items.length) {
    list.innerHTML = `<div class="empty"><strong>没有匹配的题目</strong>换个考点或关键词试试</div>`;
    state.byKey = new Map();
    return;
  }

  // 记一份「p\u0001q -> 条目」的索引：勾选时 paperset.js 需要拿题目名 / 难度，
  // 而它只知道 slug 和 qid（DOM 查询不可靠，slug 可能含特殊字符）。
  state.byKey = new Map(items.map((it) => [`${it.p}\u0001${it.q}`, it]));

  list.innerHTML = items
    .map((it) => `<div class="q-item">${questionItem(it)}</div>`)
    .join("");

  typeset(list);
}

/* ---------------------------------------------- 选题联动（供 paperset.js 回调） */

/** 单选：勾选态由复选框自己维持，这里只需刷新计数（paperset.js 已重画） */
function onSelectionChange() {
  /* 计数由 psRenderBar 负责，此处无需额外动作 */
}

/** 整批变化（清空 / 导入）后重画列表，让勾选态与选择重新对齐 */
function repaintList() {
  apply();
}

/* ---------------------------------------------- 增量加载单张试卷（带缓存） */

function paperJson(slug) {
  if (!state.paperLoad[slug]) state.paperLoad[slug] = loadPaper(slug);
  return state.paperLoad[slug];
}

/** 把一条题目引用 [slug, 题号] 补全成可渲染的条目 */
function makeItem(slug, qid, question) {
  const num = String(qid);
  return {
    p: slug,
    q: num,
    paper: paperName(slug),
    num: num.padStart(2, "0"),
    title: question ? question.title : `第 ${num} 题`,
    tags: question ? question.tags : [],
    difficulty: question ? question.difficulty : "",
    // 难度筛选只认数值字段：difficulty（中文名）用于展示，difficulty_value 用于比较
    difficulty_value: question ? question.difficulty_value : null,
  };
}

/**
 * 按 slug 分组增量取题（并发受限于浏览器，逐张串行）。
 * @param {Array} refs  待加载的题目引用 [[slug, 题号], ...]，顺序保持不变
 */
async function fetchItems(refs) {
  const byPaper = new Map();
  // 索引里带的难度值，试卷拉取失败时仍可用它保持难度筛选正确
  const dvByKey = new Map();
  for (const ref of refs) {
    const slug = ref[0], qid = ref[1];
    if (!byPaper.has(slug)) byPaper.set(slug, []);
    byPaper.get(slug).push(String(qid));
    if (ref.length > 2) dvByKey.set(refKey(slug, qid), ref[2]);
  }

  const found = new Map();

  // 一次检索可能横跨上百张试卷（如「简谐振动」命中 203 题 / 106 卷），
  // 逐张串行会慢到用户以为卡死。这里限制并发数并行拉取，
  // 既快又不至于一次性打出上百个请求。
  const slugs = [...byPaper.keys()];
  let cursor = 0;

  async function worker() {
    while (cursor < slugs.length) {
      const slug = slugs[cursor++];
      const qids = byPaper.get(slug);
      try {
        const paper = await paperJson(slug);
        const qmap = new Map();
        (paper.questions || []).forEach((q) => qmap.set(String(q.id), q));
        for (const qid of qids) {
          found.set(refKey(slug, qid), makeItem(slug, qid, qmap.get(qid)));
        }
      } catch (err) {
        // 单张试卷取不到不影响整体，降级成只有题号的条目；
        // 难度用索引下发的值兜底，避免筛选结果与总数对不上
        for (const qid of qids) {
          const it = makeItem(slug, qid, null);
          const dv = dvByKey.get(refKey(slug, qid));
          if (dv !== undefined) it.difficulty_value = dv;
          found.set(refKey(slug, qid), it);
        }
        console.warn("试卷加载失败，已降级展示：", slug, err);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, slugs.length) },
    () => worker()
  );
  await Promise.all(workers);

  return refs.map(([slug, qid]) => found.get(refKey(slug, qid))).filter(Boolean);
}

/* ---------------------------------------------- 搜索索引
   把「题目 -> 可检索文本」扁平化成一张表，关键词匹配只跑这一遍。

   可检索文本 = 该题涉及的各层级考点名 + 试卷名。
   用 \u0001 分隔不同字段，避免跨字段的假命中（如「力学X」误配「力学」）。 */

async function buildSearchIndex() {
  if (state.items) return state.items;

  // 注意：同一道题会出现在多个路径下（它自身的每一级前缀都算），
  // 例如某题同时在「力学」「力学/刚体转动」「…/转动定律」「…/转动惯量」下。
  // 因此必须先按题目聚合**所有**路径，再拼检索文本 ——
  // 只保留第一条路径会让「转动惯量」这类末级词完全搜不到。
  const byQ = new Map();
  for (const path of Object.keys(state.index)) {
    const segs = path.split("/");
    for (const ref of state.index[path]) {
      const slug = ref[0], qid = ref[1];
      const key = refKey(slug, qid);
      let rec = byQ.get(key);
      if (!rec) {
        // ref[2] 是数值难度 D、ref[3] 是文字档位序号（都可能缺省 = 未标注）
        rec = {
          slug,
          qid,
          dv: ref.length > 2 ? ref[2] : null,
          dtext: ref.length > 3 ? textOfCode(ref[3]) : "",
          names: new Set(),
        };
        byQ.set(key, rec);
      }
      // 该路径的每一级名称都是这道题的检索词
      for (const s of segs) rec.names.add(s);
    }
  }

  const list = [];
  for (const rec of byQ.values()) {
    const paper = paperName(rec.slug);
    const names = [...rec.names].filter(Boolean);
    if (paper) names.push(paper);
    list.push({
      p: rec.slug,
      q: String(rec.qid),
      paper,
      num: String(rec.qid).padStart(2, "0"),
      hay: names.join("\u0001").toLowerCase(),
      title: "",
      tags: [],
      difficulty: "",
      // 两个难度随索引下发，因此搜索时也能直接按难度过滤，无需先拉详情
      difficulty_value: rec.dv === undefined ? null : rec.dv,
      difficulty_text: rec.dtext || "",
    });
  }

  state.items = list;
  return list;
}

/**
 * 关键词匹配 + 相关性排序。
 *
 * 与旧版（纯 includes 过滤、不排序）的区别：
 *   1. 排序   旧版输入「能量守」命中 92 条却不排序，目标可能排第 63 位。
 *             现在按匹配质量打分，精确/前缀命中排最前。
 *   2. 同音字 旧版「霍耳效应」搜不到「霍尔效应」，现在经拼音归一能搜到。
 *   3. 拼音   支持 guangshanyanshe / gsys 这类拼音与首字母检索。
 *
 * 匹配逻辑：每个 token 独立打分（token 之间是「与」），
 * 题目得分 = 各 token 得分的和；按总分降序。
 * 详细打分规则见 fuzzy.js 的 scoreSeg / scoreAsciiQuery。
 */
function matchItems(list, q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return list;

  // 没有拼音数据（旧 tags.json）时退回旧的纯子串行为，保证兼容
  const py = state.pinyin;
  const hasPinyin = py && py.segs && Object.keys(py.segs).length > 0;

  if (!hasPinyin || typeof window.Fuzzy === "undefined") {
    return list.filter((it) => {
      const fields = it.hay.split("\u0001");
      return tokens.every((t) => fields.some((f) => f.includes(t)));
    });
  }

  // 每个 token 先算出它在「标签段」维度的命中分数。
  // 字段里既有考点名也有试卷名；试卷名按原文子串匹配即可。
  const tokenScores = tokens.map((t) => {
    const segHits = window.Fuzzy.matchSegs(t, py.segs, py.chars);
    // 段 -> 分数，供逐题累加（避免每题重算整张表）
    const bySeg = new Map();
    for (const h of segHits) bySeg.set(h.seg, h.score);
    return { token: t, bySeg };
  });

  const scored = [];
  for (const it of list) {
    const fields = it.hay.split("\u0001");
    let total = 0;
    let allMatched = true;

    for (const ts of tokenScores) {
      let best = 0;
      // a) 考点字段：用模糊匹配的段分数
      for (const f of fields) {
        const s = ts.bySeg.get(f);
        if (s && s > best) best = s;
      }
      // b) 原文子串兜底：试卷名等不一定在 segs 里
      if (best === 0) {
        for (const f of fields) {
          if (f.includes(ts.token)) { best = 200; break; }
        }
      }
      if (best === 0) { allMatched = false; break; }
      total += best;
    }

    if (allMatched) scored.push({ it, score: total });
  }

  // 分数高的在前；同分时保持稳定（Array.sort 在 V8 上已稳定）
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.it);
}

/* ---------------------------------------------- 主流程 */

/** 下拉填充：把某一层的选项按父节点子列表重填 */
function fillSelect(sel, children, placeholder) {
  if (!children) {
    sel.innerHTML = `<option value="">${esc(placeholder)}</option>`;
    sel.disabled = true;
    return;
  }
  sel.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    children
      .map((n) => `<option value="${esc(n.name)}">${esc(n.name)}（${n.n}）</option>`)
      .join("");
  sel.disabled = false;
}

/** 根据 state.path 同步四个下拉的选项与选中值 */
function syncSelects() {
  const sels = [1, 2, 3, 4].map((i) => document.getElementById(`f-l${i}`));
  const ph = ["全部一级", "全部二级", "全部三级", "全部四级"];

  let nodes = state.tree;
  for (let i = 0; i < LEVELS; i++) {
    const sel = sels[i];
    fillSelect(sel, nodes, ph[i]);
    const picked = state.path[i] || "";
    sel.value = picked;
    // 回填失败（数据里找不到该名字）时回退到「全部」，避免下拉与实际路径不一致
    if (sel.value !== picked) state.path = state.path.slice(0, i);

    const node = nodes && nodes.find((n) => n.name === state.path[i]);
    nodes = node && node.c && node.c.length ? node.c : null;
  }
}

/** 改动某一层下拉后：重置更浅层、刷新结果与 URL */
function selectLevel(i, value) {
  const next = state.path.slice(0, i);           // 丢弃更深层
  if (value) next[i] = value;                    // 未选则相当于停在上层
  state.path = next.filter(Boolean);
  syncSelects();
  apply();
}

function apply() {
  show(state.path.map((_, i) => i));
  syncURL();   // 无论走哪条分支都要同步 URL，便于分享 / 刷新还原

  const q = state.q.trim();

  // 未选考点且未搜索：只给引导，不全量渲染上千道题
  if (!state.path.length && !q) {
    document.getElementById("result-line").textContent = "";
    // 这里也要清掉分布提示，否则从「搜了东西」切回空白态时会残留
    const h = document.querySelector(".scope-hint");
    if (h) h.remove();
    document.getElementById("q-list").innerHTML = GUIDE_HTML;
    return;
  }

  applyFiltered(q);
}

/** 先按当前已选路径取集合，再按关键词过滤，最后按难度收窄 */
async function applyFiltered(q) {
  const list = document.getElementById("q-list");
  const line = document.getElementById("result-line");

  // 未选考点时集合为「全部题目」
  // 引用是 [slug, 题号, 难度值?] 形式
  const refs = state.path.length ? dedupeRefs(chosenRefs()) : null;
  const fallbackAll = !state.path.length;
  const refKeys = refs ? new Set(refs.map((r) => refKey(r[0], r[1]))) : null;

  const useDiff = diffActive();
  const useText = textActive();
  // 任一维度启用就走「先过滤后取详情」的快路径
  const useFilter = useDiff || useText;

  // 记下这次请求的序号：加载是异步的，若用户已经改了选择，
  // 旧结果返回时就不该再覆盖新结果。
  const seq = ++state.seq;

  line.textContent = q ? "正在检索…" : "正在加载题目…";
  // 一次可能横跨上百张试卷，先给个加载态，避免看起来像卡住
  list.innerHTML = `<div class="loading"><div class="spinner"></div>正在加载题目…</div>`;

  try {
    let hits = [];
    // 未走「全量过滤」时，总数就是 hits.length；
    // 走索引过滤时 hits 只含要渲染的前 MAX_RENDER 条，总数另算。
    let totalOverride = null;

    if (q) {
      const idx = await buildSearchIndex();
      // 选了考点：先按该考点的题目集合收窄，再过滤
      const base = refKeys
        ? idx.filter((it) => refKeys.has(refKey(it.p, it.q)))
        : idx;
      hits = matchItems(base, q);

      // 两个难度维度都已在索引里，直接在对象上过滤，无需拉详情
      if (useDiff) hits = hits.filter((it) => diffMatch(it.difficulty_value));
      if (useText) hits = hits.filter((it) => textMatch(it.difficulty_text));
    } else {
      // 未搜索：先在**引用层**按难度过滤，再只拉要渲染的那些详情。
      //
      // 难度值随索引一起下发（引用的第三、四项），所以这里不必下载全部候选试卷
      // （最坏跨 600+ 张卷、十几 MB）。先过滤、后取详情，
      // 结果行里的总数依然取自全量，不是「前 300 条里的命中数」。
      const source = refs || allRefs();
      const picked = useFilter
        ? source.filter((r) => diffMatch(r[2]) && textMatch(textOfCode(r[3])))
        : source;
      if (useFilter) {
        totalOverride = picked.length;
        hits = await fetchItems(picked.slice(0, MAX_RENDER));
      } else {
        hits = await fetchItems(picked);
      }
    }

    const total = totalOverride === null ? hits.length : totalOverride;
    const shown = hits.slice(0, MAX_RENDER);
    const hasMore = total > shown.length;

    line.textContent = buildResultLine({ total, shown: shown.length, q, fallbackAll, hasMore });

    // 命中考点跨多个分类时，在结果行下补一行分布提示。
    // 注意：每次渲染前必须先清掉上一次留下的提示，否则会累积/残留。
    const oldHint = document.querySelector(".scope-hint");
    if (oldHint) oldHint.remove();
    const hint = renderScopeHint(searchScopeInfo(q));
    if (hint) line.insertAdjacentHTML("afterend", hint);

    // 纯搜索命中的条目还没加载题目详情，渲染前按试卷批量补齐
    const need = shown.filter((it) => !it.title).map((it) => [it.p, it.q]);
    if (need.length) {
      const full = await fetchItems(need);
      const byKey = new Map(full.map((it) => [refKey(it.p, it.q), it]));
      shown.forEach((it, i) => {
        const f = byKey.get(refKey(it.p, it.q));
        if (f) shown[i] = f;
      });
    }

    // 期间用户又改了选择，这次的结果已经过期，直接丢弃
    if (seq !== state.seq) return;

    // 补齐全卷名（标签数据里的名字可能缺失）
    shown.forEach((it) => { if (!it.paper) it.paper = paperName(it.p); });

    renderList(shown);
    if (hasMore) {
      list.insertAdjacentHTML(
        "beforeend",
        `<p class="list-more">仅显示前 ${MAX_RENDER} 条，请继续收窄考点或使用搜索${
          diffActive() ? "，或调整难度范围" : ""
        }</p>`
      );
    }
  } catch (err) {
    // 过期请求的报错也不必显示
    if (seq !== state.seq) return;
    line.textContent = "加载失败";
    list.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}</div>`;
    console.error(err);
  }
}

/**
 * 全库题目引用（未选考点时用）。
 * 注意：同一道题会出现在多个路径下，必须先按 slug#qid 去重，
 * 否则「全部考点」会被重复计成好几遍。
 */
function allRefs() {
  const seen = new Set();
  const out = [];
  for (const path of Object.keys(state.index)) {
    for (const ref of state.index[path]) {
      const slug = ref[0], qid = ref[1];
      const key = refKey(slug, qid);
      if (seen.has(key)) continue;
      seen.add(key);
      // 保留第三、四项（数值难度 D / 文字档位序号），
      // 否则「不限考点 + 按难度筛选」会拿不到难度
      const copy = [slug, qid];
      if (ref.length > 2) copy.push(ref[2]);
      if (ref.length > 3) copy.push(ref[3]);
      out.push(copy);
    }
  }
  return out;
}

/** 结果行文案（纯文本，不走 HTML） */
function buildResultLine({ total, shown, q, fallbackAll, hasMore }) {
  const phrase = diffPhrase();       // "" 表示未启用难度
  const suffix = phrase ? `（${phrase}）` : "";

  if (!total) {
    return phrase ? `没有符合难度条件的题目（${phrase}）` : "没有匹配的题目";
  }

  const scope = fallbackAll
    ? `全部考点共命中 ${total} 题${suffix}`
    : `「${state.path.join(" › ")}」下命中 ${total} 题${suffix}`;

  return hasMore ? `${scope}，此处展示前 ${shown} 条` : scope;
}

/* ---------------------------------------------- 命中考点的分布提示 */

/**
 * 搜索时，统计「命中了哪些考点段」以及它们分布在哪些一级/二级分类下。
 *
 * 解决的问题：同名考点常散落在多个分类里。实测「多普勒效应」出现在 8 处
 * （力学/运动学、光学/波动光学/干涉、近代物理/原子物理/激光冷却…），
 * 用户搜到一堆题却看不出它们分属哪些体系。
 *
 * 返回 null 表示没有可展示的信息（没搜索、没拼音数据、或命中过于发散）。
 */
function searchScopeInfo(q) {
  const py = state.pinyin;
  if (!q || !py || !py.segs || typeof window.Fuzzy === "undefined") return null;

  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;   // 多词时分布信息意义不大

  let hits;
  try {
    hits = window.Fuzzy.matchSegs(tokens[0], py.segs, py.chars);
  } catch (e) {
    return null;
  }
  if (!hits.length) return null;

  // 每个命中的段，找出它在标签树里的所有路径，取前两级作为「分类」
  const branches = new Map();   // "一级/二级" -> Set(段)
  const segSet = new Set(hits.map((h) => h.seg));
  let pathCount = 0;

  for (const path of Object.keys(state.index)) {
    const segs = path.split("/");
    const last = segs[segs.length - 1];
    if (!segSet.has(last)) continue;
    pathCount++;
    const branch = segs.slice(0, 2).join(" › ");
    if (!branches.has(branch)) branches.set(branch, new Set());
    branches.get(branch).add(last);
  }

  // 只命中一个分类时不提示（没有「分布」可言）
  if (branches.size <= 1) return null;
  // 命中过散（如搜「力」）也不提示，否则列几十行没意义
  if (branches.size > 12) {
    return { tooMany: true, branchCount: branches.size, segCount: segSet.size };
  }

  const list = [...branches.entries()]
    .map(([branch, segs]) => ({ branch, segs: [...segs] }))
    .sort((a, b) => b.segs.length - a.segs.length || a.branch.localeCompare(b.branch));

  return { list, branchCount: branches.size, segCount: segSet.size, pathCount };
}

/** 把 searchScopeInfo 的结果渲染成结果行下方的一行提示 */
function renderScopeHint(info) {
  if (!info || !info.list) return "";
  const chips = info.list
    .slice(0, 8)
    .map((b) => `<span class="scope-chip">${esc(b.branch)}<b>${b.segs.length}</b></span>`)
    .join("");
  const more = info.list.length > 8 ? `<span class="scope-more">等 ${info.branchCount} 个分类</span>` : "";
  return `<div class="scope-hint">该考点分布在 ${info.branchCount} 个分类下：${chips}${more}</div>`;
}

/* ---------------------------------------------- 难度下拉初始化 */

/**
 * 按 tags.json 的 difficulty 元数据填充两个难度下拉。
 * 刻度全部来自数据（difficulty.values），页面里不写死 1/2/3。
 */
function initDiffSelects() {
  const smin = document.getElementById("f-dmin");
  const smax = document.getElementById("f-dmax");
  if (!smin || !smax) return;

  const values = Array.isArray(state.diff.values) ? state.diff.values : [];
  if (!values.length) {
    // 数据里没有难度刻度：整组隐藏（hidden 属性已在 HTML 上默认写好），
    // 页面行为退回到「只有考点 + 搜索」，不产生任何报错。
    return;
  }

  const opts = (placeholder) =>
    `<option value="">${esc(placeholder)}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(diffOptionText(v))}</option>`).join("");

  smin.innerHTML = opts("不限");
  smax.innerHTML = opts("不限");
  // 数据齐全才显形，避免刻度未加载时闪出一个空下拉
  smin.hidden = false;
  smax.hidden = false;
  syncDiffSelects();
  initTextSelect();
}

/* ---- 文字档位下拉（第二套维度）---- */

/** 用 difficulty.texts 填充「档次」下拉；无数据时保持隐藏 */
function initTextSelect() {
  const sel = document.getElementById("f-dtext");
  if (!sel) return;
  const texts = Array.isArray(state.diff.texts) ? state.diff.texts : [];
  if (!texts.length) return;   // 老数据：保持 hidden（HTML 上默认 hidden）

  const hist = state.diff.text_hist || {};
  const opts = texts
    .map((t) => {
      const n = hist[t];
      const label = Number.isFinite(Number(n)) ? `${t}（${n}）` : t;
      return `<option value="${esc(t)}">${esc(label)}</option>`;
    })
    .join("");
  sel.innerHTML = `<option value="">不限</option>${opts}`;
  sel.hidden = false;
  // 外层 span 默认 hidden，数据齐全才一起显形
  const wrap = document.getElementById("f-dtext-wrap");
  if (wrap) wrap.hidden = false;
  syncTextSelect();
}

/** 把 state.dtext 写回「档次」下拉 */
function syncTextSelect() {
  const sel = document.getElementById("f-dtext");
  if (!sel) return;
  sel.value = textActive() ? state.dtext : "";
}

/** 改动「档次」下拉 */
function selectText(value) {
  state.dtext = (state.diff.texts || []).includes(value) ? value : "";
  syncTextSelect();
  apply();
}

/** 把 state.dmin / state.dmax 写回两个下拉（下拉不存在时静默跳过） */
function syncDiffSelects() {
  const smin = document.getElementById("f-dmin");
  const smax = document.getElementById("f-dmax");
  if (!smin || !smax) return;
  smin.value = selectedMin();
  smax.value = selectedMax();
}

/* ---------------------------------------------- URL 同步 */

function syncURL() {
  const params = new URLSearchParams();
  if (state.path.length) params.set("t", state.path.join("/"));
  if (state.q.trim()) params.set("q", state.q.trim());
  // 难度上下限：只在选了合法刻度时才写进 URL
  if (selectedMin() !== "") params.set("dmin", selectedMin());
  if (selectedMax() !== "") params.set("dmax", selectedMax());
  // 文字档位
  if (textActive()) params.set("dt", state.dtext);
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

/** 从 URL 还原选择：路径逐级校验，非法层级自动截断；难度刻度也要在 values 里 */
function restoreFromURL() {
  const t = (getParam("t") || "").trim();
  const q = (getParam("q") || "").trim();
  const dmin = (getParam("dmin") || "").trim();
  const dmax = (getParam("dmax") || "").trim();
  const dt = (getParam("dt") || "").trim();

  if (t) {
    const names = t.split("/");
    let nodes = state.tree;
    for (const name of names) {
      const node = nodes && nodes.find((n) => n.name === name);
      if (!node) break;
      state.path.push(node.name);
      nodes = node.c && node.c.length ? node.c : null;
    }
  }
  if (q) state.q = q;

  // 难度参数校验：不在 difficulty.values 里的一律忽略，当作「不限」。
  // getParam 已经做过一次解码，这里不再 decodeURIComponent，
  // 否则上下文里合法的字面量 "%" 会被二次解码并抛 URIError。
  const dv = (s) => String(s).trim();
  const d1 = dv(dmin);
  const d2 = dv(dmax);
  if (d1 && diffRank(d1) >= 0) state.dmin = d1;
  if (d2 && diffRank(d2) >= 0) state.dmax = d2;
  // 文字档位：必须在 difficulty.texts 里才认
  if (dt && (state.diff.texts || []).includes(dt)) state.dtext = dt;
  // URL 里若写反了（dmin>dmax），纠正成合法区间，避免筛出莫名其妙的空结果
  normalizeDiffRange();
}

/* ---------------------------------------------- 事件绑定 */

function initFilters() {
  for (let i = 0; i < LEVELS; i++) {
    document.getElementById(`f-l${i + 1}`).addEventListener("change", (e) => {
      selectLevel(i, e.target.value);
    });
  }

  const input = document.getElementById("f-q");
  let timer = null;
  input.addEventListener("input", (e) => {
    state.q = e.target.value;
    // 轻微防抖，避免每次按键都重跑全量匹配
    clearTimeout(timer);
    timer = setTimeout(apply, 140);
  });

  // 难度上下限：改动后纠正顺序（min>max 时抬 max）并重新筛选
  const dmin = document.getElementById("f-dmin");
  const dmax = document.getElementById("f-dmax");
  if (dmin) {
    dmin.addEventListener("change", (e) => {
      state.dmin = e.target.value || "";
      normalizeDiffRange();
      apply();
    });
  }
  if (dmax) {
    dmax.addEventListener("change", (e) => {
      state.dmax = e.target.value || "";
      normalizeDiffRange();
      apply();
    });
  }

  // 文字档位（第二套维度）
  const dtext = document.getElementById("f-dtext");
  if (dtext) {
    dtext.addEventListener("change", (e) => selectText(e.target.value || ""));
  }

  document.getElementById("f-reset").addEventListener("click", () => {
    state.path = [];
    state.q = "";
    state.dmin = "";
    state.dmax = "";
    state.dtext = "";
    input.value = "";
    syncSelects();
    syncDiffSelects();
    syncTextSelect();
    apply();
    input.focus();
  });

  // 面包屑点击回退到该级
  document.getElementById("crumb-path").addEventListener("click", (e) => {
    const btn = e.target.closest(".crumb-step");
    if (!btn) return;
    state.path = state.path.slice(0, Number(btn.dataset.i) + 1);
    syncSelects();
    apply();
  });

  // 从带参数的链接进入、或用户手动改地址栏后返回时的兜底。
  // 说明：日常选择走的是 replaceState（不产生历史条目），
  // 所以这里主要处理「真实导航」的情形。
  window.addEventListener("popstate", () => {
    state.path = [];
    state.q = "";
    state.dmin = "";
    state.dmax = "";
    restoreFromURL();
    input.value = state.q;
    syncSelects();
    syncDiffSelects();
    apply();
  });
}

/* ---------------------------------------------- 启动 */

(async function main() {
  renderTopbar([{ label: "题库", href: "library.html" }, { label: "考点" }]);

  try {
    const data = await fetchJSON(`${DATA_ROOT}/tags.json`);
    state.tree = data.tree || [];
    state.index = data.index || {};
    // tags.json 自带 slug -> 试卷名 映射，避免再拉一遍 papers.json
    state.nameMap = data.papers || {};

    // 拼音数据（模糊搜索用）。旧版 tags.json 可能没有这个键，
    // 此时 matchItems 会自动退回纯子串匹配。
    state.pinyin = data.pinyin || { chars: {}, segs: {} };

    // 难度刻度元数据（values / labels / hist / unit）全部来自数据
    const d = data.difficulty || {};
    state.diff = {
      values: Array.isArray(d.values) ? d.values.map(String) : [],
      labels: d.labels || {},
      hist: d.hist || {},
      unit: d.unit || "",
      // 第二套维度：文字档位（顺序即由易到难）
      texts: Array.isArray(d.texts) ? d.texts.map(String) : [],
      text_hist: d.text_hist || {},
    };

    if (data.stats) {
      const desc = document.querySelector(".page-desc");
      if (desc) {
        desc.insertAdjacentHTML(
          "beforeend",
          ` 当前收录 ${esc(data.stats.questions)} 道题目、${esc(data.stats.tags)} 个考点。`
        );
      }
    }

    // 选题栏：先读已存的选择，再建界面，最后绑事件
    if (typeof psLoad === "function") {
      psLoad();
      psRenderBar();
      psBindList(document.getElementById("q-list"), (slug, qid) => {
        // 展示信息优先从当前列表数据里取（有题目名），取不到就退回试卷名。
        const rec = state.byKey && state.byKey.get(`${slug}\u0001${qid}`);
        return {
          name: (rec && rec.paper) || (state.nameMap && state.nameMap[slug]) || "",
          title: (rec && rec.title) || "",
          difficulty: (rec && rec.difficulty_value) ?? "",
        };
      });
    }

    // 难度下拉必须在 restoreFromURL 之前建好：还原时要往回填选中值
    initDiffSelects();
    restoreFromURL();
    syncSelects();
    syncDiffSelects();
    syncTextSelect();
    initFilters();
    apply();
  } catch (err) {
    document.getElementById("q-list").innerHTML =
      `<div class="empty"><strong>考点数据加载失败</strong>${esc(err.message)}</div>`;
    console.error(err);
  }
})();
