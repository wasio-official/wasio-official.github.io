/* ============================================================
   选题与出卷目录：勾选题目 → 导出/导入 paperset.json
   ------------------------------------------------------------
   设计要点（与「出卷工具链方案.md」一致）：
   - **导出引用，不导出内容**：只记「选了哪道题 + 怎么排」，
     题目正文由本地工具按 slug+qid 去取。文件因此极小（几十题几 KB）。
   - **纯前端、无后端**：导出就是个 Blob 下载；导入走 FileReader。
     不涉及任何账号，网站保持免登录。
   - 选择存在 localStorage，刷新/跳页不丢。
   - 这个文件同时被 paper.html / question.html / tags.html 使用，
     所以叫 paperset 而不是挂在某个页面里。
   ============================================================ */

const PAPERSET_VERSION = 1;
const PAPERSET_FORMAT = "wasio-paperset";
const PAPERSET_LS_KEY = "wasio.paperset.v1";

/** 选中项：key = "slug#qid"，value = {paper, qid, score, note, name, title, difficulty} */
const selection = new Map();

/* ---------------------------------------------- 持久化 */

function psLoad() {
  try {
    const raw = localStorage.getItem(PAPERSET_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const items = Array.isArray(obj.items) ? obj.items : [];
    items.forEach((it) => {
      if (!it || !it.paper || it.qid === undefined) return;
      selection.set(psKey(it.paper, it.qid), {
        paper: String(it.paper),
        qid: String(it.qid),
        score: it.score ?? "",
        note: it.note || "",
        name: it.name || "",
        title: it.title || "",
        difficulty: it.difficulty || "",
      });
    });
    // 卷头也一起还原（供 psRenderBar 首次填充）
    psLoad._meta = obj.meta || null;
  } catch (err) {
    console.warn("读取已选题目失败（忽略）：", err);
  }
}

function psSave() {
  try {
    localStorage.setItem(
      PAPERSET_LS_KEY,
      JSON.stringify({
        format: PAPERSET_FORMAT, version: PAPERSET_VERSION,
        meta: psMetaRead(), items: psItems(),
      })
    );
  } catch (err) {
    // 隐私模式下 localStorage 可能不可写 —— 不影响本次使用，只是刷新会丢
    console.warn("保存已选题目失败（可能处于隐私模式）：", err);
  }
}

/**
 * 读当前卷头控件里的值。
 *
 * ⚠️ 关键：卷头控件只在「有选题栏的页面」上存在（paper/tags/question 都插了栏，
 * 但别处未必）。若控件不在，**不能返回空值** —— 那会把用户已经填好、存在
 * localStorage 里的卷头抹掉（在题库页勾一道题就丢标题，实测踩过）。
 * 因此控件缺失时回退到已存盘的卷头。
 */
function psMetaRead() {
  const g = (id) => document.getElementById(id);
  const has = !!g("ps-title") || !!g("ps-subtitle") || !!g("ps-duration");

  if (!has) {
    // 界面上没有卷头控件：沿用已有的
    try {
      const prev = JSON.parse(localStorage.getItem(PAPERSET_LS_KEY) || "{}");
      if (prev && prev.meta) return prev.meta;
    } catch { /* 读不出来就当没有 */ }
    return { title: "", subtitle: "", duration: 0, one_per_page: false, show_analysis: false };
  }

  return {
    title: (g("ps-title") || {}).value || "",
    subtitle: (g("ps-subtitle") || {}).value || "",
    duration: Number((g("ps-duration") || {}).value) || 0,
    one_per_page: !!(g("ps-oneperpage") || {}).checked,
    show_analysis: !!(g("ps-analysis") || {}).checked,
  };
}

/** 卷头变化即刻存盘（输入时不重建界面，只落盘） */
function psMetaSave() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAPERSET_LS_KEY) || "{}");
    raw.format = PAPERSET_FORMAT;
    raw.version = PAPERSET_VERSION;
    raw.meta = psMetaRead();
    raw.items = psItems();
    localStorage.setItem(PAPERSET_LS_KEY, JSON.stringify(raw));
  } catch { /* 隐私模式忽略 */ }
}

/* ---------------------------------------------- 基本操作 */

const psKey = (slug, qid) => `${slug}#${qid}`;

const psHas = (slug, qid) => selection.has(psKey(slug, qid));
const psCount = () => selection.size;

function psToggle(slug, qid, extra = {}) {
  const k = psKey(slug, qid);
  if (selection.has(k)) {
    selection.delete(k);
    return false;
  }
  selection.set(k, {
    paper: String(slug),
    qid: String(qid),
    score: extra.score ?? "",
    note: "",
    name: extra.name || "",
    title: extra.title || "",
    difficulty: extra.difficulty || "",
  });
  return true;
}

function psRemove(slug, qid) {
  return selection.delete(psKey(slug, qid));
}

function psClear() {
  selection.clear();
}

/** 导出用的条目数组，按加入顺序；order 由调用方或此处补齐 */
function psItems() {
  return [...selection.values()];
}

/* ---------------------------------------------- 导出 / 导入 */

function psDownload(filename) {
  const payload = {
    format: PAPERSET_FORMAT,
    version: PAPERSET_VERSION,
    exported_at: new Date().toISOString(),
    site: location.origin + location.pathname.replace(/[^/]*$/, ""),
    meta: {
      title: (document.getElementById("ps-title") || {}).value || "",
      subtitle: (document.getElementById("ps-subtitle") || {}).value || "",
      duration: Number((document.getElementById("ps-duration") || {}).value) || 0,
      one_per_page: !!((document.getElementById("ps-oneperpage") || {}).checked),
      show_analysis: !!((document.getElementById("ps-analysis") || {}).checked),
    },
    items: psItems().map((it, i) => ({
      paper: it.paper,
      qid: it.qid,
      order: i + 1,
      score: it.score === "" ? null : Number(it.score),
      note: it.note || "",
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `paperset-${psStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给浏览器读完再释放，立即 revoke 在部分浏览器会下到空文件
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function psStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 导入 paperset.json。
 * @returns {Promise<{added:number, total:number, meta:object}>}
 */
function psImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onload = () => {
      let obj;
      try {
        obj = JSON.parse(String(reader.result));
      } catch {
        reject(new Error("不是合法的 JSON 文件"));
        return;
      }
      if (!obj || obj.format !== PAPERSET_FORMAT) {
        reject(new Error("这不是本站导出的选题目录（format 不匹配）"));
        return;
      }
      const items = Array.isArray(obj.items) ? obj.items : [];
      if (!items.length) {
        reject(new Error("目录里没有任何题目"));
        return;
      }

      let added = 0;
      // 导入语义：**替换**当前选择，而不是叠加 —— 叠加会让反复导入越滚越多
      selection.clear();
      items.forEach((it, i) => {
        if (!it || !it.paper || it.qid === undefined) return;
        selection.set(psKey(it.paper, it.qid), {
          paper: String(it.paper),
          qid: String(it.qid),
          score: it.score ?? "",
          note: it.note || "",
          name: it.name || "",
          title: it.title || "",
          difficulty: it.difficulty || "",
        });
        added++;
      });

      // 卷头信息回填（有对应控件时才填）
      const m = obj.meta || {};
      const put = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      const tick = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      put("ps-title", m.title);
      put("ps-subtitle", m.subtitle);
      put("ps-duration", m.duration || "");
      tick("ps-oneperpage", m.one_per_page);
      tick("ps-analysis", m.show_analysis);

      psSave();
      resolve({ added, total: items.length, meta: m });
    };
    reader.readAsText(file, "utf-8");
  });
}

/* ---------------------------------------------- 界面 */

/**
 * 渲染顶部的「已选 N 题」工具条。
 * 各页面只需放一个 <div id="ps-bar"></div>，其余由这里生成。
 */
function psRenderBar() {
  const host = document.getElementById("ps-bar");
  if (!host) return;

  const n = psCount();

  // ⚠️ psRenderBar 会整块重建，会清掉用户正在输入的卷头内容。
  // 每次重建前先把当前值记下来，建完再填回去。
  const keep = {
    title: (host.querySelector("#ps-title") || {}).value,
    subtitle: (host.querySelector("#ps-subtitle") || {}).value,
    duration: (host.querySelector("#ps-duration") || {}).value,
    oneperpage: (host.querySelector("#ps-oneperpage") || {}).checked,
    analysis: (host.querySelector("#ps-analysis") || {}).checked,
  };
  const hadMeta = !!host.querySelector("#ps-title");

  host.innerHTML = `
    <div class="ps-bar">
      <span class="ps-count">已选 <b>${n}</b> 题</span>
      <button class="ctl" id="ps-export" type="button" ${n ? "" : "disabled"}>导选出卷目录</button>
      <button class="ctl" id="ps-import-btn" type="button">导入目录</button>
      <button class="ctl" id="ps-clear" type="button" ${n ? "" : "disabled"}>清空</button>
      <input type="file" id="ps-file" accept=".json,application/json" hidden>
    </div>

    <details class="ps-meta" ${n ? "" : "open"}>
      <summary>卷头信息（导出时一并带上，本地出卷工具会用）</summary>
      <div class="ps-meta-grid">
        <label>试卷标题<input id="ps-title" type="text" placeholder="物理竞赛模拟卷 1"></label>
        <label>副标题<input id="ps-subtitle" type="text" placeholder="力学专题"></label>
        <label>考试时长（分钟）<input id="ps-duration" type="number" min="0" step="5" placeholder="180"></label>
      </div>
      <div class="ps-meta-checks">
        <label><input id="ps-oneperpage" type="checkbox"> 每页一道题</label>
        <label><input id="ps-analysis" type="checkbox"> 含解析与答案</label>
      </div>
      <p class="ps-meta-note">
        「含解析」默认关闭 —— 出给学生做的卷子通常不带解析。导入目录时这些信息会自动回填。
      </p>
    </details>

    <div class="ps-msg" id="ps-msg" hidden></div>
  `;

  // 回填上一轮的卷头内容（首次渲染时 hadMeta 为 false，不覆盖导入回填的值）
  if (hadMeta) {
    const set = (id, v) => { const el = host.querySelector("#" + id); if (el && v != null && v !== "") el.value = v; };
    set("ps-title", keep.title);
    set("ps-subtitle", keep.subtitle);
    set("ps-duration", keep.duration);
    const t1 = host.querySelector("#ps-oneperpage"); if (t1) t1.checked = keep.oneperpage;
    const t2 = host.querySelector("#ps-analysis"); if (t2) t2.checked = keep.analysis;
  } else {
    // 首次渲染：用 psLoad 读到的卷头（跨页面/刷新后仍然保留）
    const m = psLoad._meta;
    if (m) {
      const set = (id, v) => { const el = host.querySelector("#" + id); if (el && v != null && v !== "" && v !== 0) el.value = v; };
      set("ps-title", m.title);
      set("ps-subtitle", m.subtitle);
      set("ps-duration", m.duration);
      const c1 = host.querySelector("#ps-oneperpage"); if (c1) c1.checked = !!m.one_per_page;
      const c2 = host.querySelector("#ps-analysis"); if (c2) c2.checked = !!m.show_analysis;
    }
  }

  // 卷头变化时记住，下次重建才不会丢
  ["ps-title", "ps-subtitle", "ps-duration", "ps-oneperpage", "ps-analysis"].forEach((id) => {
    const el = host.querySelector("#" + id);
    if (!el) return;
    el.addEventListener("change", psMetaSave);
    if (el.type === "text" || el.type === "number") el.addEventListener("input", psMetaSave);
  });

  host.querySelector("#ps-export").addEventListener("click", () => psDownload());
  host.querySelector("#ps-clear").addEventListener("click", () => {
    if (!psCount()) return;
    if (!confirm(`确定清空已选的 ${psCount()} 道题？`)) return;
    psClear();
    psAfterBatch();   // 整批变化：需要重画列表，否则勾还打着
  });

  const fileInput = host.querySelector("#ps-file");
  host.querySelector("#ps-import-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const r = await psImportFile(f);
      // 先刷新界面再提示 —— 反过来的话 psRenderBar 会把提示抹掉
      psAfterBatch();
      psNotice(`已导入 ${r.added} 道题（替换原有选择）`, "ok");
    } catch (err) {
      psNotice(`导入失败：${err.message}`, "err");
    }
    // 复位，否则连续导入同一个文件不触发 change
    e.target.value = "";
  });
}

function psNotice(text, kind) {
  const el = document.getElementById("ps-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `ps-msg ${kind || ""}`;
  el.hidden = false;
  clearTimeout(psNotice._t);
  psNotice._t = setTimeout(() => { el.hidden = true; }, 5000);
}

/** 选择变化后：存盘 + 重画计数 + 让页面刷新勾选态 */
function psAfterChange() {
  psSave();

  // ⚠️ psRenderBar 会重建 ps-bar 整块（含 ps-msg）。若此时正好有提示要显示，
  // 重建会把提示抹掉 —— 所以由调用方在 psAfterChange 之后再调 psNotice。
  const prev = document.getElementById("ps-msg");
  const keepText = prev && !prev.hidden ? prev.textContent : "";
  const keepCls = prev && !prev.hidden ? prev.className : "ps-msg";

  psRenderBar();

  if (keepText) {
    const el = document.getElementById("ps-msg");
    if (el) {
      el.textContent = keepText;
      el.className = keepCls;
      el.hidden = false;
      clearTimeout(psNotice._t);
      psNotice._t = setTimeout(() => { el.hidden = true; }, 5000);
    }
  }

  if (typeof onSelectionChange === "function") onSelectionChange();
}

/**
 * 整批变化（清空 / 导入 / 全选）后的收尾。
 *
 * 与 psAfterChange 的区别：这些操作会一次性改很多项，单个复选框的 DOM 状态
 * 已经与 selection 脱节，必须重画列表。
 * **绝不能在单个复选框点击时调用** —— 那会在事件处理途中重建 DOM，
 * 导致刚勾上的那一次丢失（实测踩过）。
 */
function psAfterBatch() {
  psAfterChange();
  if (typeof repaintList === "function") repaintList();
}

/**
 * 给题目行绑定复选框：用事件委托，避免每次重渲染都要重新绑定。
 * @param {HTMLElement} host 容器
 * @param {(slug:string, qid:string) => object} extraOf 取附加信息（标题/难度等）
 */
function psBindList(host, extraOf) {
  if (!host || host.dataset.psBound === "1") return;
  host.dataset.psBound = "1";

  // ⚠️ 这里必须用 `change` 而不是 `click`：
  // 在 click 里对复选框调 preventDefault() 会**取消浏览器自身的勾选翻转**，
  // 而那次翻转是在事件派发**结束之后**才生效的 —— 于是会出现
  // 「selection 已经加了、DOM 却仍是未勾选」的错位（实测踩过）。
  // change 在状态已定之后触发，语义正好。
  host.addEventListener("change", (e) => {
    const box = e.target.closest(".ps-check");
    if (!box) return;
    const { slug, qid } = box.dataset;
    if (box.checked) {
      psToggle(slug, qid, extraOf ? extraOf(slug, qid) : {});
    } else if (psHas(slug, qid)) {
      // 取消勾选：只在确实选中时删，避免重复触发时误删
      psRemove(slug, qid);
    }
    // 以 selection 为准回写，防止两边不一致
    box.checked = psHas(slug, qid);
    psAfterChange();
  });

  // 复选框与题目链接并排（不是嵌在 <a> 里），所以正常点击本来就不会跳转。
  // 这里只做一件事：阻止冒泡，避免将来有人把它挪进链接里时踩坑。
  // ⚠️ 绝不能在复选框上 preventDefault()：那会取消浏览器自身的勾选翻转，
  // 而 change 事件正是靠那次翻转才触发的 —— 实测会导致「怎么点都没反应」。
  host.addEventListener("click", (e) => {
    if (e.target.closest(".ps-check-wrap")) e.stopPropagation();
  });
}

/**
 * 复选框 HTML 片段。
 * @param {string} slug 试卷 slug
 * @param {string} qid  题号
 * @param {string} [text] 有值则在框后加一段说明文字（单题页用）
 */
function psCheckbox(slug, qid, text) {
  const on = psHas(slug, qid) ? " checked" : "";
  const label = text ? `<span class="ps-check-text">${esc(text)}</span>` : "";
  return `<label class="ps-check-wrap" title="加入出卷目录">
    <input type="checkbox" class="ps-check" data-slug="${esc(slug)}" data-qid="${esc(qid)}"${on}>
    ${label}
  </label>`;
}
