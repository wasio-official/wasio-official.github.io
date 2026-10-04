/* ============================================================
   首页：试卷目录 + 搜索 / 筛选
   ============================================================ */

const state = {
  papers: [],
  stats: {},
  q: "",
  category: "",
  sort: "year",
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
  const tags = (p.tags || [])
    .slice(0, 3)
    .map((t) => {
      const leaf = t.split("/").pop();
      return `<span class="tag" title="${esc(t)}">${esc(leaf)}</span>`;
    })
    .join("");

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
      if ((p.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
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

  const grid = document.getElementById("grid");
  const line = document.getElementById("result-line");

  line.textContent = `显示 ${list.length} / ${state.papers.length} 套试卷`;

  grid.innerHTML = list.length
    ? list.map(paperCard).join("")
    : `<div class="empty" style="grid-column:1/-1">
         <strong>没有匹配的试卷</strong>换个关键词或清除筛选试试
       </div>`;
}

function initStats() {
  const s = state.stats || {};
  document.getElementById("stat-papers").textContent = s.papers ?? "—";
  document.getElementById("stat-questions").textContent = s.questions ?? "—";
  document.getElementById("stat-images").textContent = s.images ?? "—";
}

function initFilters() {
  const cats = [...new Set(state.papers.map((p) => p.category))].sort();
  const sel = document.getElementById("f-cat");
  sel.innerHTML =
    `<option value="">全部类型</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

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
}

(async function main() {
  renderTopbar([]);
  try {
    const data = await loadPapers();
    state.papers = data.papers || [];
    state.stats = data.stats || {};
    initStats();
    initFilters();
    apply();
  } catch (err) {
    document.getElementById("grid").innerHTML =
      `<div class="empty" style="grid-column:1/-1">
         <strong>数据加载失败</strong>${esc(err.message)}
       </div>`;
    console.error(err);
  }
})();
