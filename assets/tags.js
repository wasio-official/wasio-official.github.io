/* ============================================================
   考点导航页：四级考点级联筛选 + 关键词检索 + 跨卷题目汇总

   数据：data/tags.json
     tree   四级考点树，节点 { name, n, c }
     index  完整路径（用 "/" 连接）→ 题目引用数组 [ [slug, 题号], ... ]
            每一级路径在 index 里都有条目，因此「选到哪一级就按
            哪一级汇总」天然成立。
     papers 试卷 slug → 试卷显示名
     stats  { tags, questions }

   标签展示规则统一由 app.js 的 renderTags / TAGS_CONFIG 控制，
   本文件不重复实现标签渲染。
   ============================================================ */

/** 结果列表最多渲染多少条（超出的只提示、不渲染） */
const MAX_RENDER = 300;

/** 级联层数（与数据里的 levels 保持一致） */
const LEVELS = 4;

/** 未选考点、也没搜索时的引导文案 */
const GUIDE_HTML = `
  <div class="empty">
    <strong>请先选择考点</strong>
    在上方四个下拉框里从「一级考点」开始逐级收窄，<br>
    或直接用搜索框检索考点名称、试卷名。
  </div>`;

const state = {
  tree: [],            // 四级考点树
  index: {},           // 路径 → 题目引用数组 [ [slug, 题号], ... ]
  nameMap: {},         // 试卷 slug → 试卷显示名（优先用 tags.json 的 papers）
  paperLoad: {},       // 试卷 slug → Promise（增量加载题干/标签，做缓存）

  path: [],            // 当前选中的考点路径，如 ["力学", "刚体转动"]
  q: "",               // 搜索关键词

  // 搜索索引：全部题目的扁平清单（含路径 / 试卷名 / 检索串）
  items: null,
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

/** 把题目引用数组去重（同一题在多个标签下可能重复出现） */
function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const [slug, qid] of refs) {
    const key = refKey(slug, qid);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([slug, qid]);
  }
  return out;
}

/* ---------------------------------------------- 题目条目渲染
   视觉结构对齐 paper.js 的 questionItem，额外加一枚试卷名 chip。 */

function questionItem(it) {
  const tags = renderTags(it.tags, { empty: "未标注考点" });
  // 外层是 <a>，内部不能再嵌套 <a>，因此试卷名只作为 chip 文本展示
  const paper = it.paper ? `<span class="chip chip-cat">${esc(it.paper)}</span>` : "";

  return `
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
    </a>`;
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
    return;
  }

  list.innerHTML = items
    .map((it) => `<div class="q-item">${questionItem(it)}</div>`)
    .join("");

  typeset(list);
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
  };
}

/**
 * 按 slug 分组增量取题（并发受限于浏览器，逐张串行）。
 * @param {Array} refs  待加载的题目引用 [[slug, 题号], ...]，顺序保持不变
 */
async function fetchItems(refs) {
  const byPaper = new Map();
  for (const [slug, qid] of refs) {
    if (!byPaper.has(slug)) byPaper.set(slug, []);
    byPaper.get(slug).push(String(qid));
  }

  const found = new Map();
  for (const [slug, qids] of byPaper) {
    try {
      const paper = await paperJson(slug);
      const qmap = new Map();
      (paper.questions || []).forEach((q) => qmap.set(String(q.id), q));
      for (const qid of qids) {
        found.set(refKey(slug, qid), makeItem(slug, qid, qmap.get(qid)));
      }
    } catch (err) {
      // 单张试卷取不到不影响整体，降级成只有题号的条目
      for (const qid of qids) found.set(refKey(slug, qid), makeItem(slug, qid, null));
      console.warn("试卷加载失败，已降级展示：", slug, err);
    }
  }

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
    for (const [slug, qid] of state.index[path]) {
      const key = refKey(slug, qid);
      let rec = byQ.get(key);
      if (!rec) {
        rec = { slug, qid, names: new Set() };
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
    });
  }

  state.items = list;
  return list;
}

/**
 * 关键词匹配：题目的考点名（任一级）或试卷名包含关键词即算命中。
 * 多个关键词之间是「与」的关系。
 */
function matchItems(list, q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return list;

  return list.filter((it) => {
    const fields = it.hay.split("\u0001");
    return tokens.every((t) => fields.some((f) => f.includes(t)));
  });
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
    document.getElementById("q-list").innerHTML = GUIDE_HTML;
    return;
  }

  applyFiltered(q);
}

/** 先按当前已选路径取集合，再按关键词过滤 */
async function applyFiltered(q) {
  const list = document.getElementById("q-list");
  const line = document.getElementById("result-line");

  // 未选考点时集合为「全部题目」
  // dedupeRefs 返回的是 [slug, 题号] 二元数组，这里统一成 key 集合
  const refs = state.path.length ? dedupeRefs(chosenRefs()) : null;
  const fallbackAll = !state.path.length;
  const refKeys = refs ? new Set(refs.map(([slug, qid]) => refKey(slug, qid))) : null;

  line.textContent = q ? "正在检索…" : "正在加载题目…";

  try {
    let hits = [];

    if (q) {
      const idx = await buildSearchIndex();
      // 选了考点：先按该考点的题目集合收窄，再过滤
      const base = refKeys
        ? idx.filter((it) => refKeys.has(refKey(it.p, it.q)))
        : idx;
      hits = matchItems(base, q);
    } else {
      hits = await fetchItems(refs);
    }

    const total = hits.length;
    const shown = hits.slice(0, MAX_RENDER);
    const hasMore = total > shown.length;

    line.textContent = buildResultLine({ total, shown: shown.length, q, fallbackAll, hasMore });

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

    // 补齐全卷名（标签数据里的名字可能缺失）
    shown.forEach((it) => { if (!it.paper) it.paper = paperName(it.p); });

    renderList(shown);
    if (hasMore) {
      list.insertAdjacentHTML(
        "beforeend",
        `<p class="list-more">仅显示前 ${MAX_RENDER} 条，请继续收窄考点或使用搜索</p>`
      );
    }
  } catch (err) {
    line.textContent = "加载失败";
    list.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}</div>`;
    console.error(err);
  }
}

/** 结果行文案（纯文本，不走 HTML） */
function buildResultLine({ total, shown, q, fallbackAll, hasMore }) {
  if (!total) return "没有匹配的题目";

  const scope = fallbackAll
    ? `全部考点共命中 ${total} 题`
    : `「${state.path.join(" › ")}」下命中 ${total} 题`;

  return hasMore ? `${scope}，此处展示前 ${shown} 条` : scope;
}

/* ---------------------------------------------- URL 同步 */

function syncURL() {
  const params = new URLSearchParams();
  if (state.path.length) params.set("t", state.path.join("/"));
  if (state.q.trim()) params.set("q", state.q.trim());
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

/** 从 URL 还原选择：路径逐级校验，非法层级自动截断 */
function restoreFromURL() {
  const t = (getParam("t") || "").trim();
  const q = (getParam("q") || "").trim();

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

  document.getElementById("f-reset").addEventListener("click", () => {
    state.path = [];
    state.q = "";
    input.value = "";
    syncSelects();
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
    restoreFromURL();
    input.value = state.q;
    syncSelects();
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

    if (data.stats) {
      const desc = document.querySelector(".page-desc");
      if (desc) {
        desc.insertAdjacentHTML(
          "beforeend",
          ` 当前收录 ${esc(data.stats.questions)} 道题目、${esc(data.stats.tags)} 个考点。`
        );
      }
    }

    restoreFromURL();
    syncSelects();
    initFilters();
    apply();
  } catch (err) {
    document.getElementById("q-list").innerHTML =
      `<div class="empty"><strong>考点数据加载失败</strong>${esc(err.message)}</div>`;
    console.error(err);
  }
})();
