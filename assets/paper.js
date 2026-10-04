/* ============================================================
   试卷页：列出该卷全部题目（仅显示题号 + 难度 + 考点标签）
   标签展示规则统一由 app.js 的 TAGS_CONFIG / renderTags 控制。
   ============================================================ */

const state = { paper: null, q: "" };

function questionItem(item, index, slug) {
  const tags = renderTags(item.tags, { empty: "未标注考点" });

  return `
    <a class="q-link" href="question.html?p=${encodeURIComponent(slug)}&q=${encodeURIComponent(item.id)}">
      <span class="q-num">${String(index + 1).padStart(2, "0")}</span>
      <span class="q-body">
        <span class="q-title-row">
          <span class="q-title">${esc(item.title)}</span>
          ${difficultyChip(item.difficulty)}
          ${item.score && item.score.D ? `<span class="chip">难度 ${esc(item.score.D)}</span>` : ""}
        </span>
        <span class="q-tags">${tags}</span>
      </span>
      <span class="q-arrow">›</span>
    </a>`;
}

function apply() {
  const p = state.paper;
  const q = state.q.trim().toLowerCase();
  let list = p.questions;

  if (q) {
    list = list.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  document.getElementById("result-line").textContent =
    q ? `匹配 ${list.length} / ${p.questions.length} 题`
      : `共 ${p.questions.length} 题`;

  document.getElementById("q-list").innerHTML = list.length
    ? list.map((it, i) => `<div class="q-item">${questionItem(it, i, p.slug)}</div>`).join("")
    : `<div class="empty"><strong>没有匹配的题目</strong>换个关键词试试</div>`;
}

(async function main() {
  const slug = getParam("id");
  renderTopbar([{ label: "题库", href: "library.html" }]);

  if (!slug) {
    document.getElementById("q-list").innerHTML =
      `<div class="empty"><strong>缺少试卷参数</strong><a href="library.html">返回题库</a></div>`;
    return;
  }

  try {
    const paper = await loadPaper(slug);
    state.paper = paper;
    document.title = `${paper.name} — 物理竞赛题库`;

    const mix = {};
    paper.questions.forEach((it) => {
      const k = it.difficulty || "未标注";
      mix[k] = (mix[k] || 0) + 1;
    });
    const mixChips = ["简单", "中等", "较难"]
      .filter((k) => mix[k])
      .map((k) => {
        const cls = { 简单: "chip-easy", 中等: "chip-mid", 较难: "chip-hard" }[k];
        return `<span class="chip ${cls}">${k} ${mix[k]}</span>`;
      })
      .join("");

    document.getElementById("paper-head").innerHTML = `
      <h1>${esc(paper.name)}</h1>
      <div class="card-meta">
        <span class="chip chip-cat">${paper.questions.length} 题</span>
        ${mixChips}
      </div>
    `;

    renderTopbar([
      { label: "题库", href: "library.html" },
      { label: paper.name },
    ]);

    document.getElementById("f-q").addEventListener("input", (e) => {
      state.q = e.target.value;
      apply();
    });

    apply();
  } catch (err) {
    document.getElementById("q-list").innerHTML =
      `<div class="empty"><strong>试卷加载失败</strong>${esc(err.message)}
       <p><a href="library.html">返回题库</a></p></div>`;
    console.error(err);
  }
})();
