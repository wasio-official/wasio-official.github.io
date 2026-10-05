/* ============================================================
   单题页：题目 / 详细解析 / 答案
   默认折叠「详细解析」「答案」，提供「显示全部」开关。
   ============================================================ */

const state = { paper: null, index: 0 };

const DIM_LABELS = {
  A1: "A1 洞察", A2: "A2 算力", A3: "A3 建模",
  B1: "B1 广度", B2: "B2 深度", B3: "B3 工具",
  C1: "C1 引导", C2: "C2 陷阱", C3: "C3 边界",
  D1: "D1 新颖", D2: "D2 精度",
};
const DIM_ORDER = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2"];

function scorePanel(score) {
  if (!score || Object.keys(score).length === 0) return "";

  const dims = DIM_ORDER.map((k) => {
    const v = score[k];
    const has = v !== undefined && v !== null && String(v).trim() !== "";
    return `<div class="dim">
      <div class="dim-k">${DIM_LABELS[k]}</div>
      <div class="dim-v${has ? "" : " empty"}">${has ? esc(v) : "—"}</div>
    </div>`;
  }).join("");

  const dVal = score.D ? esc(score.D) : "—";
  const note = score.note ? `<p class="score-note">${esc(score.note)}</p>` : "";

  return `
    <details class="score-panel">
      <summary>难度评分${score.D ? ` — D = ${dVal}` : ""}（11 维度）</summary>
      <div class="inner">
        <div class="dims">
          <div class="dim" style="background:var(--accent-soft)">
            <div class="dim-k">D 整体</div>
            <div class="dim-v">${dVal}</div>
          </div>
          ${dims}
        </div>
        ${note}
      </div>
    </details>`;
}

function panel(id, title, bodyHtml, opts = {}) {
  const { collapsible = false, open = false, hint = "", extraClass = "" } = opts;
  const cls = ["panel", collapsible ? "collapsible" : "", open ? "open" : "", extraClass]
    .filter(Boolean).join(" ");

  return `
    <section class="${cls}" id="${id}">
      <div class="panel-head">
        <h2>${esc(title)}</h2>
        ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
        ${collapsible ? `<span class="lock-badge">${open ? "已展开" : "已隐藏"}</span>
        <span class="caret">▸</span>` : ""}
      </div>
      <div class="panel-body ${extraClass === "answer-body" ? "answer-body" : ""}">
        ${bodyHtml}
      </div>
    </section>`;
}

function renderQuestion() {
  const { paper, index } = state;
  const item = paper.questions[index];
  const total = paper.questions.length;

  document.title = `${item.title} · ${paper.name} — Wasio的物理竞赛题库`;

  // 面包屑
  renderTopbar([
    { label: "题库", href: "library.html" },
    { label: paper.name, href: `paper.html?id=${encodeURIComponent(paper.slug)}` },
    { label: item.title },
  ]);

  // 单题页：展示标签（规则同样统一走 TAGS_CONFIG）
  const tags = renderTags(item.tags);

  const prev = index > 0 ? paper.questions[index - 1] : null;
  const next = index < total - 1 ? paper.questions[index + 1] : null;
  const qLink = (it) =>
    `question.html?p=${encodeURIComponent(paper.slug)}&q=${encodeURIComponent(it.id)}`;

  document.getElementById("q-head").innerHTML = `
    <h1>${esc(item.title)}</h1>
    <div class="paper-ref">
      <a href="paper.html?id=${encodeURIComponent(paper.slug)}">${esc(paper.name)}</a>
      <span style="color:var(--line-strong)"> · </span>第 ${index + 1} / ${total} 题
    </div>
    <div class="card-meta">
      ${difficultyChip(item.difficulty)}
      ${item.score && item.score.D ? `<span class="chip">难度 ${esc(item.score.D)}</span>` : ""}
    </div>
    ${tags ? `<div class="q-tags">${tags}</div>` : ""}
  `;

  // 正文
  const parts = [];

  parts.push(panel("p-content", "题目内容", `<div class="md">${renderMarkdown(item.content)}</div>`));

  if (item.analysis) {
    parts.push(
      panel("p-analysis", "详细解析", `<div class="md">${renderMarkdown(item.analysis)}</div>`, {
        collapsible: true,
        hint: "点击展开",
      })
    );
  }

  if (item.answer) {
    parts.push(
      panel("p-answer", "答案", `<div class="md">${renderMarkdown(item.answer)}</div>`, {
        collapsible: true,
        hint: "点击展开",
        extraClass: "answer-body",
      })
    );
  }

  // 题内导航
  parts.push(`
    <nav class="q-nav">
      ${prev
        ? `<a class="btn" href="${qLink(prev)}">← ${esc(prev.title)}</a>`
        : `<span></span>`}
      <a class="btn" href="paper.html?id=${encodeURIComponent(paper.slug)}">返回试卷目录</a>
      ${next
        ? `<a class="btn" href="${qLink(next)}">${esc(next.title)} →</a>`
        : `<span></span>`}
    </nav>`);

  const host = document.getElementById("q-main");
  host.innerHTML = scorePanel(item.score) + parts.join("");

  setupCollapsible(host);
  typeset(host);
  setupShowAll();
  setupKeyboard();
}

/* ---------------------------------------------- 显示全部 / 隐藏全部 */

function setupShowAll() {
  const btn = document.getElementById("btn-toggle-all");
  if (!btn) return;

  const panels = () => [...document.querySelectorAll(".panel.collapsible")];

  const sync = () => {
    const ps = panels();
    const anyClosed = ps.some((p) => !p.classList.contains("open"));
    btn.textContent = ps.length === 0 ? "无折叠内容"
      : anyClosed ? "显示全部" : "隐藏全部";
    btn.disabled = ps.length === 0;
  };

  btn.addEventListener("click", () => {
    const ps = panels();
    const anyClosed = ps.some((p) => !p.classList.contains("open"));
    ps.forEach((p) => {
      p.classList.toggle("open", anyClosed);
      const badge = p.querySelector(".lock-badge");
      if (badge) badge.textContent = anyClosed ? "已展开" : "已隐藏";
    });
    if (anyClosed) typeset(document.getElementById("q-main"));
    sync();
  });

  // 折叠面板被单独点击后，同步按钮文案
  document.querySelectorAll(".panel.collapsible .panel-head").forEach((h) =>
    h.addEventListener("click", () => setTimeout(sync, 0))
  );

  sync();
}

/* ---------------------------------------------- 键盘快捷键 */

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    const { paper, index } = state;
    const go = (i) => {
      if (i < 0 || i >= paper.questions.length) return;
      const it = paper.questions[i];
      location.href = `question.html?p=${encodeURIComponent(paper.slug)}&q=${encodeURIComponent(it.id)}`;
    };
    if (e.key === "ArrowLeft") go(index - 1);
    if (e.key === "ArrowRight") go(index + 1);
  });
}

/* ---------------------------------------------- 启动 */

(async function main() {
  renderTopbar([]);
  const slug = getParam("p");
  const qid = getParam("q");

  if (!slug || !qid) {
    document.getElementById("q-main").innerHTML =
      `<div class="empty"><strong>缺少参数</strong>请从<a href="library.html">题库</a>进入</div>`;
    return;
  }

  try {
    const paper = await loadPaper(slug);
    let idx = paper.questions.findIndex((it) => String(it.id) === String(qid));
    if (idx < 0) idx = 0;

    state.paper = paper;
    state.index = idx;
    renderQuestion();
  } catch (err) {
    document.getElementById("q-main").innerHTML =
      `<div class="empty"><strong>题目加载失败</strong>${esc(err.message)}
       <p><a href="library.html">返回题库</a></p></div>`;
    console.error(err);
  }
})();
