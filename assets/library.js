/* ============================================================
   题库页：试卷目录 + 搜索 / 筛选 / 排序
   ============================================================ */

const state = {
  papers: [],
  stats: {},
  q: "",
  category: "",
  sort: "year",
  visible: [],        // 当前筛选后的试卷（「随机一份」的抽取范围）
  lastRandom: "",     // 上次随到的 slug，避免连点两次跳到同一套
};

function difficultyMixHTML(mix) {
  if (!mix) return "";
  const order = ["简单", "中等", "较难"];
  const cls = { 简单: "chip-easy", 中等: "chip-mid", 较难: "chip-hard" };
  return order
    .filter((k) => mix[k])
    .map((k) => `<span class="chip ${cls[k]}">${k} ${mix[k]}</span>`)
    .join("");
}

function paperCard(p) {
  // 试卷标签预览 —— 预留字段驱动，当前数据为空，卡片上不显示任何标签。
  // 将来数据补上 p.tags 后会自动出现，无需改动这里。
  const tags = renderTags(p.tags, { max: PAPER_TAGS_CONFIG.max });

  return `
    <a class="paper-card" href="paper.html?id=${encodeURIComponent(p.slug)}">
      <h3>${esc(p.name)}</h3>
      <div class="card-meta">
        ${p.year ? `<span class="chip">${esc(p.year)}</span>` : ""}
        <span class="chip chip-cat">${esc(p.category)}</span>
      </div>
      ${tags ? `<div class="card-tags">${tags}</div>` : ""}
      <div class="card-foot">
        <span>${p.count} 题</span>
        <span style="color:var(--line-strong)">·</span>
        <span>${p.images} 图</span>
        <span style="flex:1"></span>
        ${difficultyMixHTML(p.difficulty)}
      </div>
    </a>`;
}

function apply() {
  const q = state.q.trim().toLowerCase();
  let list = state.papers;

  if (q) {
    list = list.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      // 预留字段参与检索；字段为空时这一段自然不命中
      if (PAPER_TAGS_CONFIG.search && (p.tags || []).some((t) => String(t).toLowerCase().includes(q))) return true;
      return false;
    });
  }
  if (state.category) {
    list = list.filter((p) => p.category === state.category);
  }

  const sorters = {
    year: (a, b) => (b.year || "").localeCompare(a.year || "") || a.name.localeCompare(b.name, "zh"),
    count: (a, b) => b.count - a.count,
    name: (a, b) => a.name.localeCompare(b.name, "zh"),
  };
  list = [...list].sort(sorters[state.sort] || sorters.year);

  // 记下当前筛选结果，供「随机一份」使用（随机应只在可见范围内抽）
  state.visible = list;

  const grid = document.getElementById("grid");
  const line = document.getElementById("result-line");

  line.textContent = q || state.category
    ? `显示 ${list.length} / ${state.papers.length} 套试卷`
    : `共 ${state.papers.length} 套试卷`;

  // 没有可抽的试卷时，随机按钮置灰，避免点了没反应
  const lucky = document.getElementById("f-lucky");
  if (lucky) {
    lucky.disabled = list.length === 0;
    lucky.title = list.length
      ? `从当前 ${list.length} 套里随机打开一份`
      : "当前筛选下没有可打开的试卷";
  }

  grid.innerHTML = list.length
    ? list.map(paperCard).join("")
    : `<div class="empty" style="grid-column:1/-1">
         <strong>没有匹配的试卷</strong>换个关键词或清除筛选试试
       </div>`;
}

/**
 * 随机打开一套试卷。
 *
 * 语义：从**当前筛选结果**里抽（若你在搜「力学」，就只从命中的试卷里抽），
 * 而不是从全库 700+ 套里抽 —— 后者会让筛选形同虚设。
 *
 * 另外避免「连点两次跳到同一套」：那不像随机，像没反应。
 * 只有 1 套可选时就不再避让（否则会永远抽不出来）。
 */
function openRandom() {
  const pool = state.visible || [];
  if (!pool.length) return;

  let pick;
  if (pool.length === 1) {
    pick = pool[0];
  } else {
    do {
      pick = pool[Math.floor(Math.random() * pool.length)];
    } while (state.lastRandom && pick.slug === state.lastRandom);
  }
  state.lastRandom = pick.slug;

  location.href = `paper.html?id=${encodeURIComponent(pick.slug)}`;
}

function initFilters() {
  // 类型下拉：来自数据，按数量降序
  const freq = {};
  state.papers.forEach((p) => { freq[p.category] = (freq[p.category] || 0) + 1; });
  const cats = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b, "zh"));

  const sel = document.getElementById("f-cat");
  sel.innerHTML =
    `<option value="">全部类型</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}（${freq[c]}）</option>`).join("");

  document.getElementById("f-q").addEventListener("input", (e) => {
    state.q = e.target.value;
    apply();
  });
  sel.addEventListener("change", (e) => {
    state.category = e.target.value;
    apply();
  });
  document.getElementById("f-sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    apply();
  });
  document.getElementById("f-lucky").addEventListener("click", openRandom);
}

(async function main() {
  renderTopbar([{ label: "题库" }]);
  try {
    const data = await loadPapers();
    state.papers = data.papers || [];
    state.stats = data.stats || {};
    initFilters();
    apply();

    // 支持 library.html#search 直接聚焦搜索框
    if (location.hash === "#search") {
      const input = document.getElementById("f-q");
      input.focus();
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch (err) {
    document.getElementById("grid").innerHTML =
      `<div class="empty" style="grid-column:1/-1">
         <strong>数据加载失败</strong>${esc(err.message)}
       </div>`;
    console.error(err);
  }
})();
