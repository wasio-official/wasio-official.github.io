/* ============================================================
   网页出卷：把一份 paperset（wasio-paperset）渲染成可打印的 A4 文档
   ------------------------------------------------------------
   设计要点（与「出卷版式规范.md」保持观感一致）：
   - 全程在浏览器里完成：读本地 JSON → fetch 题目 → 渲染 → 调 window.print()。
     **没有上传、没有后端、不会写进仓库或站点任何目录。**
   - 题目正文复用 app.js 的 renderMarkdown（公式占位、图片、轻量 Markdown），
     再由 MathJax 统一排版；打印前等图片与 MathJax 都就绪。
   - 题卷默认一题一页；题干 < 350 字且图片 ≤ 2 的短题不强制分页，允许自然连排。
   - 答案卷自然连排；「解析：」「答案：」为空时整段省略。
   - 正文（含图片）严格按源数据顺序渲染：这里**不做任何图片重排**。
     图片位置由题库数据本身决定，渲染层只负责把相对路径补成
     data/images/<slug>/... 并保证尺寸 / 加载失败占位。
   ============================================================ */

const PB_LS_KEY =
  typeof PAPERSET_LS_KEY === "string" ? PAPERSET_LS_KEY : "wasio.paperset.v1";

const pbState = {
  meta: {},
  items: [],
  mode: "questions",
  busy: false,
};

/** slug → 试卷 JSON，避免同一套卷被反复 fetch */
const pbPaperCache = new Map();

/* ---------------------------------------------- 小工具 */

const pbEl = (id) => document.getElementById(id);

function pbEsc(s) {
  if (typeof esc === "function") return esc(s);
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pbToday() {
  if (typeof psDateISO === "function") return psDateISO();
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 未填标题时的自动卷名：物理竞赛组卷·YYYY-MM-DD·N题 */
function pbAutoName(n) {
  if (typeof psAutoName === "function") return psAutoName(n);
  return `物理竞赛组卷·${pbToday()}·${n || 0}题`;
}

/** 当前输入框里的标题；空则用自动卷名 */
function pbTitle() {
  const el = pbEl("pg-title");
  const v = el ? String(el.value || "").trim() : "";
  return v || pbAutoName(pbState.items.length);
}

function pbNotice(text, kind) {
  const el = pbEl("pg-msg");
  if (!el) return;
  el.textContent = text;
  el.className = "pg-msg" + (kind ? " " + kind : "");
  el.hidden = false;
}

function pbSetStatus(text) {
  const el = pbEl("pg-status");
  if (el) el.textContent = text;
}

function pbSetBusy(busy) {
  pbState.busy = !!busy;
  document.body.classList.toggle("pg-busy", pbState.busy);
  pbEnableButtons(!pbState.busy && pbState.items.length > 0);
}

function pbEnableButtons(on) {
  ["pg-print-q", "pg-print-a", "pg-print-both"].forEach((id) => {
    const b = pbEl(id);
    if (b) b.disabled = !on;
  });
}

/* ---------------------------------------------- 中文序号 */

const PB_CN_DIGITS = "零一二三四五六七八九";

function pbCnUnder100(n) {
  if (n < 10) return PB_CN_DIGITS[n];
  if (n < 20) return "十" + (n % 10 ? PB_CN_DIGITS[n % 10] : "");
  return PB_CN_DIGITS[Math.floor(n / 10)] + "十" + (n % 10 ? PB_CN_DIGITS[n % 10] : "");
}

/** 1 → 一，10 → 十，11 → 十一，21 → 二十一，105 → 一百零五 */
function pbCnNumber(n) {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return String(n);
  if (n < 100) return pbCnUnder100(n);
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    if (!r) return PB_CN_DIGITS[h] + "百";
    if (r < 10) return PB_CN_DIGITS[h] + "百零" + PB_CN_DIGITS[r];
    // 110 读作「一百一十」，不是「一百十」——百位之后十位要补一个「一」
    return PB_CN_DIGITS[h] + "百" + (r < 20 ? "一" : "") + pbCnUnder100(r);
  }
  return String(n);
}

/* ---------------------------------------------- 读取 / 校验 paperset */

function pbReadLocal() {
  try {
    const raw = localStorage.getItem(PB_LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (
      obj &&
      obj.format === "wasio-paperset" &&
      Array.isArray(obj.items) &&
      obj.items.length
    ) {
      return obj;
    }
  } catch (err) {
    console.warn("[pdfbuild] 读取本机组卷失败（忽略）：", err);
  }
  return null;
}

/**
 * 校验并归一化 paperset。
 * 只做结构校验，不 fetch 题目；返回按 order 排好的条目。
 */
function pbParseSet(obj) {
  if (!obj || typeof obj !== "object") throw new Error("不是合法的 JSON");
  if (obj.format !== "wasio-paperset") {
    throw new Error("这不是本站导出的选题目录（format 不匹配）");
  }
  const list = Array.isArray(obj.items) ? obj.items : [];
  if (!list.length) throw new Error("目录里没有任何题目");

  const items = [];
  list.forEach((it, i) => {
    if (!it || !it.paper || it.qid === undefined || it.qid === null) return;
    items.push({
      paper: String(it.paper),
      qid: String(it.qid),
      order: Number(it.order),
      score: it.score == null ? "" : it.score,
      note: it.note || "",
      idx: i,
    });
  });
  if (!items.length) throw new Error("目录里没有任何可用的题目");

  // 全都有 order 时按 order 排；否则保持文件里的顺序（sort 在现代浏览器里是稳定的）
  if (items.every((it) => Number.isFinite(it.order))) {
    items.sort((a, b) => a.order - b.order || a.idx - b.idx);
  }
  return { meta: obj.meta || {}, items };
}

/** 按 slug 并行取卷，再按 qid 找题；取不到的记进 missing，绝不静默漏题 */
async function pbFetchItems(entries) {
  const slugs = [...new Set(entries.map((it) => it.paper))];
  const missing = [];

  await Promise.all(
    slugs.map(async (slug) => {
      if (pbPaperCache.has(slug)) return;
      try {
        pbPaperCache.set(slug, await loadPaper(slug));
      } catch (err) {
        missing.push(`${slug}（试卷加载失败）`);
        console.warn("[pdfbuild] 试卷加载失败：", slug, err);
      }
    })
  );

  const items = [];
  for (const e of entries) {
    const paper = pbPaperCache.get(e.paper);
    if (!paper) continue;
    const q = (paper.questions || []).find((x) => String(x.id) === e.qid);
    if (!q) {
      missing.push(`${paper.name || e.paper} 第 ${e.qid} 题`);
      continue;
    }
    items.push({
      slug: e.paper,
      name: paper.name || e.paper,
      qid: e.qid,
      q,
      score: e.score,
    });
  }
  return { items, missing };
}

/* ---------------------------------------------- 图片路径 / 加载 */

/**
 * 题目 JSON 里的图片有两种写法：
 *   data/images/<slug>/xxx.jpg  —— 当前数据的完整相对路径，直接用
 *   images/xxx.jpg              —— 旧数据/手写 paperset 的简写，要补 slug 目录
 * 其余（http(s)、data:、blob:）原样保留。
 */
function pbImageURL(raw, slug) {
  const s = String(raw || "").trim();
  if (!s) return s;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(s)) return s;
  if (/^data:/i.test(s) || /^blob:/i.test(s)) return s;
  if (s.indexOf("data/images/") === 0) return s;
  if (s.indexOf("./data/images/") === 0) return s.slice(2);
  if (s.indexOf("/data/images/") === 0) return s.slice(1);
  if (/^(?:\.\/)?images\//.test(s)) {
    return "data/images/" + slug + "/" + s.replace(/^(?:\.\/)?images\//, "");
  }
  return s;
}

/** 取路径最后一段（占位提示里显示文件名，不显示整条长路径） */
function pbBaseName(s) {
  const t = String(s || "").split(/[?#]/)[0];
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

function pbFixImages(host, slug) {
  if (!host) return;
  host.querySelectorAll("img").forEach((img) => {
    const fixed = pbImageURL(img.getAttribute("src"), slug);
    if (fixed) img.setAttribute("src", fixed);
    // 打印前必须已经解码，lazy 会让 offscreen 的图来不及加载
    img.setAttribute("loading", "eager");
    img.addEventListener("error", () => {
      img.classList.add("img-missing");
      if (!img.alt) img.alt = "（图片加载失败）";
      // 加载失败时 <img> 只剩一个破图标（alt 也未必打得出来）。
      // 换成明确的占位文本：打印/预览都能看到是哪张图缺了，且不会抛异常。
      const miss = document.createElement("span");
      miss.className = "img-missing";
      miss.textContent = "（图片加载失败：" + pbBaseName(fixed) + "）";
      if (img.parentNode) img.parentNode.replaceChild(miss, img);
      console.warn("[pdfbuild] 图片加载失败：", fixed);
    }, { once: true });
  });
}

/** 等 #paper 里所有图片 load/error（最多 10 秒） */
function pbWaitImages(root) {
  if (!root) return Promise.resolve();
  const jobs = [];
  root.querySelectorAll("img").forEach((img) => {
    if (img.complete) return;
    jobs.push(
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        img.addEventListener("load", finish, { once: true });
        img.addEventListener("error", finish, { once: true });
        setTimeout(finish, 10000);
      })
    );
  });
  return Promise.all(jobs);
}

/* ---------------------------------------------- Markdown 预处理 */

const PB_IMG_RE = /!\[[^\]]*\]\([^)]+\)/g;

/**
 * 在 Markdown 文本层面就把图片地址补成站点真实路径。
 *
 * 为什么不等渲染完再改 <img src>：innerHTML 一建好浏览器就会按原路径发请求，
 * 后补前缀等于先发一次 404、再发一次正确请求（控制台多一条报错，还慢一拍）。
 * 这里直接改文本，<img> 一出生 src 就是对的。
 */
function pbRewriteImages(md, slug) {
  return String(md || "").replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (m, alt, raw) => {
    const s = String(raw).trim();
    if (!s) return m;
    const sp = s.split(/\s+/);
    const url = pbImageURL(sp[0], slug);
    const extra = sp.slice(1).join(" ");
    return `![${alt}](${url}${extra ? " " + extra : ""})`;
  });
}

function pbIsEscaped(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/**
 * 还原正文里的 Markdown 转义：`\_` → `_`。
 *
 * 题库正文是从 LaTeX 源文整理的，填空横线写成 `\_\_\_\_`。站点页面不处理
 * 反斜杠（公式里的 `\_` 必须保留），打印出来就会是「\_\_\_\_」而不是横线。
 * 这里只做一件事：**公式区间之外的** `\_` 去反斜杠；`$…$` / `$$…$$` 整段
 * 原样跳过，绝不碰公式内容。
 */
function pbUnescapeText(md) {
  const s = String(md || "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "_") { out += "_"; i += 2; continue; }
    if (c === "$" && !pbIsEscaped(s, i)) {
      const delim = s[i + 1] === "$" ? "$$" : "$";
      const close = s.indexOf(delim, i + delim.length);
      if (close > i) {
        out += s.slice(i, close + delim.length);
        i = close + delim.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** 渲染前的统一预处理：还原转义 + 补全图片路径 */
function pbPrepareMd(md, slug) {
  return pbRewriteImages(pbUnescapeText(md), slug);
}

/* ---------------------------------------------- 渲染 */

/**
 * 把 <p> 里误嵌的块级公式 .math-block 提出来。
 *
 * renderMarkdown 会把独占一行的 $$…$$ 渲染成 `<p><div class="math-block">…</div></p>`，
 * 浏览器解析时会自动拆成三段（两个空 <p> 各带一段下边距），公式前后凭空多出空白。
 * 这里在 MathJax 之前先拆干净：连续文字仍进 <p>，公式块成为独立 <div>。
 */
function pbLiftMathBlocks(host) {
  if (!host) return;
  host.querySelectorAll("p").forEach((p) => {
    if (!p.querySelector(".math-block")) return;
    const parent = p.parentNode;
    if (!parent) return;

    const frag = document.createDocumentFragment();
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const np = document.createElement("p");
      run.forEach((n) => np.appendChild(n));
      if (np.textContent.trim() || np.querySelector("img")) frag.appendChild(np);
      run = [];
    };
    Array.prototype.forEach.call(p.childNodes, (n) => {
      if (n.nodeType === 1 && n.classList && n.classList.contains("math-block")) {
        flush();
        frag.appendChild(n);
      } else {
        run.push(n);
      }
    });
    flush();
    parent.insertBefore(frag, p);
    parent.removeChild(p);
  });

  // 真浏览器解析 `<p><div>` 时会自己拆成 `<p></p><div></div><p></p>`，
  // 于是公式前后各剩一个空段落（各带 .7em 下边距）—— 一并清掉。
  host.querySelectorAll("p").forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector("img")) {
      if (p.parentNode) p.parentNode.removeChild(p);
    }
  });
}

/**
 * 渲染一段 Markdown 为 .q-md 容器。
 * 正文与图片顺序**完全按源数据**，这里不做任何重排。
 */
function pbRenderBlocks(md, slug) {
  const host = document.createElement("div");
  host.className = "q-md";
  host.innerHTML = renderMarkdown(pbPrepareMd(md, slug));
  pbLiftMathBlocks(host);
  return host;
}

/**
 * 把「一、」「解析：」这类标签挂到第一个块级元素开头；
 * 正文以公式 / 列表 / 引用开头时也能正确落位，实在没有块级元素才自建一段。
 */
function pbLabelInto(host, html, fallbackTag) {
  const first =
    host.querySelector("p") ||
    host.querySelector("blockquote") ||
    host.querySelector("li") ||
    host.querySelector("h1, h2, h3, h4, h5, h6") ||
    host.querySelector("pre") ||
    host.querySelector("table");
  if (first) first.insertAdjacentHTML("afterbegin", html);
  else host.insertAdjacentHTML("afterbegin", `<${fallbackTag}>${html}</${fallbackTag}>`);
}

/** 把「一、」插到第一个块级元素开头；没有块级元素就单独起一行 */
function pbPrependNo(host, cn) {
  pbLabelInto(host, `<span class="q-no">${pbEsc(cn)}、</span>`, "p");
}

/** 「解析：」「答案：」段落：标签加粗，跟在第一段开头 */
function pbAnswerSection(text, slug, label) {
  const t = String(text || "").trim();
  if (!t) return null;
  const md = document.createElement("div");
  md.className = "q-md q-answer-md";
  md.innerHTML = renderMarkdown(pbPrepareMd(t, slug));
  pbLiftMathBlocks(md);
  pbFixImages(md, slug);

  pbLabelInto(md, `<span class="q-label">${pbEsc(label)}：</span>`, "p");
  return md;
}

function pbPlainLength(s) {
  return String(s || "")
    .replace(PB_IMG_RE, "")
    .replace(/\s+/g, "").length;
}

function pbCountImages(s) {
  return (String(s || "").match(PB_IMG_RE) || []).length;
}

function pbBuildItem(item, idx, mode) {
  const q = item.q;
  const content = q.content || "";

  const art = document.createElement("article");
  art.className = "q-item";
  art.dataset.slug = item.slug;
  art.dataset.qid = item.qid;

  const stem = document.createElement("div");
  stem.className = "q-stem";
  const md = pbRenderBlocks(content, item.slug);
  pbFixImages(md, item.slug);
  pbPrependNo(md, pbCnNumber(idx + 1));
  stem.appendChild(md);
  art.appendChild(stem);

  if (mode === "answers") {
    const box = document.createElement("div");
    box.className = "q-ans";
    let added = 0;
    const analysis = pbAnswerSection(q.analysis, item.slug, "解析");
    if (analysis) { box.appendChild(analysis); added++; }
    const answer = pbAnswerSection(q.answer, item.slug, "答案");
    if (answer) { box.appendChild(answer); added++; }
    if (added) art.appendChild(box);
  }

  // 题卷短题判定：题干 < 350 字且图片 ≤ 2 → 不强制分页
  if (mode === "questions" && pbPlainLength(content) < 350 && pbCountImages(content) <= 2) {
    art.classList.add("q-short");
  }
  return art;
}

function pbHeader(kind, title, subtitle, duration, n) {
  const head = document.createElement("header");
  head.className = "sheet-head";

  // 卷头信息行：题卷与答案卷一致 ——「本卷共 N 题　考试时间 X 分钟」；
  // 没填时长就只保留题数，不会打出「考试时间 0 分钟」。
  let meta = `本卷共 ${n} 题`;
  if (duration) meta += `\u3000考试时间 ${duration} 分钟`;

  head.innerHTML =
    `<h1 class="sheet-title">${pbEsc(title)}</h1>` +
    (kind === "answers" ? `<p class="sheet-sub sheet-kind">参考答案</p>` : "") +
    (subtitle ? `<p class="sheet-sub">${pbEsc(subtitle)}</p>` : "") +
    `<p class="sheet-meta">${pbEsc(meta)}</p>`;
  return head;
}

function pbBuildPart(kind, title, subtitle, duration) {
  const part = document.createElement("section");
  part.className = "paper-part part-" + kind;
  part.dataset.kind = kind;
  part.appendChild(pbHeader(kind, title, subtitle, duration, pbState.items.length));
  pbState.items.forEach((item, i) => {
    part.appendChild(pbBuildItem(item, i, kind));
  });
  return part;
}

/** 清空并渲染指定模式；等图片 + MathJax 完成后才 resolve */
async function pbRender(mode) {
  const paper = pbEl("paper");
  if (!paper) return;

  pbState.mode = mode;
  if (!pbState.items.length) {
    pbInitialEmpty();
    return;
  }

  const title = pbTitle();
  const subtitle = (pbEl("pg-subtitle") || {}).value || "";
  const duration = Number((pbEl("pg-duration") || {}).value) || 0;

  paper.innerHTML = "";
  paper.dataset.mode = mode;
  if (mode === "questions" || mode === "both") {
    paper.appendChild(pbBuildPart("questions", title, String(subtitle).trim(), duration));
  }
  if (mode === "answers" || mode === "both") {
    paper.appendChild(pbBuildPart("answers", title, String(subtitle).trim(), duration));
  }

  await pbWaitImages(paper);
  // MathJax 排版完成前不允许打印 —— 否则打印出来是原始 \(...\) 源码
  await pbTypeset(paper);
}

async function pbTypeset(el) {
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) { /* 字体探测失败不影响 */ }
  }
  if (typeof typeset === "function") {
    await typeset(el);
    return;
  }
  // 理论上 app.js 一定会加载；这里留一个独立兜底
  if (!window.MathJax || !window.MathJax.typesetPromise) return;
  try {
    await window.MathJax.typesetPromise([el]);
  } catch (err) {
    console.warn("[pdfbuild] MathJax 排版失败：", err);
  }
}

/* ---------------------------------------------- 载入组卷 */

function pbFillMeta(meta, n) {
  const t = pbEl("pg-title");
  const s = pbEl("pg-subtitle");
  const d = pbEl("pg-duration");
  if (t) {
    t.value = meta.title || "";
    t.placeholder = "留空自动命名：" + pbAutoName(n);
  }
  if (s) s.value = meta.subtitle || "";
  if (d) d.value = meta.duration || "";

  // 复选框默认勾选；文件里显式写了 show_analysis 时遵从文件
  const a = pbEl("pg-analysis");
  if (a) a.checked = typeof meta.show_analysis === "boolean" ? meta.show_analysis : true;
}

function pbDefaultMode() {
  const a = pbEl("pg-analysis");
  return a && !a.checked ? "questions" : "answers";
}

async function pbApplySet(set, sourceLabel) {
  pbSetBusy(true);
  try {
    const parsed = pbParseSet(set);
    pbState.meta = parsed.meta || {};
    pbFillMeta(pbState.meta, parsed.items.length);
    pbSetStatus("正在读取题目…");

    const { items, missing } = await pbFetchItems(parsed.items);
    if (!items.length) {
      throw new Error("题目一道都没取到，请检查 JSON 里的 paper / qid");
    }

    pbState.items = items;
    const missText = missing.length
      ? `；${missing.length} 项没取到：${missing.slice(0, 3).join("、")}${missing.length > 3 ? "…" : ""}`
      : "";
    pbSetStatus(`已载入 ${items.length} 道题${sourceLabel ? "（" + sourceLabel + "）" : ""}${missText}`);
    if (missing.length) console.warn("[pdfbuild] 下列题目没有取到：", missing);

    await pbRender(pbDefaultMode());

    pbNotice(
      missing.length
        ? `已载入 ${items.length} 题；${missing.length} 项没取到（详见控制台）`
        : `已载入 ${items.length} 道题`,
      missing.length ? "err" : "ok"
    );
  } catch (err) {
    pbState.items = [];
    pbSetStatus("没有可用的组卷。");
    pbShowEmpty("载入失败", err.message);
    pbNotice("载入失败：" + err.message, "err");
    console.error("[pdfbuild] 载入失败：", err);
  } finally {
    pbSetBusy(false);
  }
}

function pbInitialEmpty() {
  const paper = pbEl("paper");
  if (!paper) return;
  paper.innerHTML = `
    <div class="pg-empty">
      <strong>还没有选题</strong>
      <p>先到 <a href="tags.html">考点导航</a> 或 <a href="library.html">题库</a>
      勾几道题，再从状态条点「生成 PDF」；也可以上传 / 粘贴组卷 JSON。</p>
    </div>`;
}

function pbShowEmpty(title, msg) {
  const paper = pbEl("paper");
  if (!paper) return;
  paper.innerHTML = `
    <div class="pg-empty">
      <strong>${pbEsc(title)}</strong>
      <p>${pbEsc(msg || "")}</p>
    </div>`;
}

/* ---------------------------------------------- 上传 / 粘贴 */

function pbLoadFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name || "")) {
    pbNotice("请选择 .json 文件", "err");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => pbNotice("文件读取失败", "err");
  reader.onload = () => pbLoadText(String(reader.result), file.name);
  reader.readAsText(file, "utf-8");
}

async function pbLoadText(text, label) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch (err) {
    pbNotice("不是合法的 JSON 文件", "err");
    return;
  }
  await pbApplySet(obj, label || "手动载入");
}

function pbWireUI() {
  const q = pbEl("pg-print-q");
  const a = pbEl("pg-print-a");
  const both = pbEl("pg-print-both");
  if (q) q.addEventListener("click", () => pbPrint("questions"));
  if (a) a.addEventListener("click", () => pbPrint("answers"));
  if (both) both.addEventListener("click", () => pbPrint("both"));

  // 卷头 / 模式变化后重画预览；打印时也会重新读取输入框
  const rerender = () => {
    if (pbState.items.length && !pbState.busy) pbRender(pbDefaultMode());
  };
  ["pg-title", "pg-subtitle", "pg-duration"].forEach((id) => {
    const el = pbEl(id);
    if (el) el.addEventListener("change", rerender);
  });
  const analysis = pbEl("pg-analysis");
  if (analysis) analysis.addEventListener("change", rerender);

  const drop = pbEl("pg-drop");
  const file = pbEl("pg-file");
  if (drop && file) {
    drop.addEventListener("click", () => file.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        file.click();
      }
    });
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add("is-over");
      })
    );
    ["dragleave", "dragend"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove("is-over");
      })
    );
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("is-over");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) pbLoadFile(f);
      else pbNotice("没有读到文件，请重试", "err");
    });
    file.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) pbLoadFile(f);
      // 复位，否则连续导入同一个文件不触发 change
      e.target.value = "";
    });
  }

  const useJson = pbEl("pg-use-json");
  if (useJson) {
    useJson.addEventListener("click", () => {
      const t = (pbEl("pg-json") || {}).value || "";
      if (!t.trim()) {
        pbNotice("文本框是空的，先粘贴 JSON", "err");
        return;
      }
      pbLoadText(t, "粘贴的 JSON");
    });
  }
}

/* ---------------------------------------------- 打印 */

async function pbPrint(mode) {
  if (pbState.busy) return;
  if (!pbState.items.length) {
    pbNotice("还没有可打印的题目", "err");
    return;
  }
  pbSetBusy(true);
  try {
    // pbRender 内部已经等图片 + MathJax 完成；这里不再重复，避免二次排版。
    await pbRender(mode);
    if (pbState.mode !== mode || !pbEl("paper").childElementCount) {
      throw new Error("页面没有渲染出内容");
    }
  } catch (err) {
    console.error("[pdfbuild] 打印前渲染失败：", err);
    pbNotice("生成失败：" + (err && err.message ? err.message : err), "err");
    return;
  } finally {
    pbSetBusy(false);
  }

  // 打印对话框里的「文件名」默认取 document.title —— 换成卷名，存下来的 PDF 才不会
  // 叫「Wasio的网页出卷 — 物理竞赛题库」。
  const suffix =
    mode === "answers" ? "·答案卷" : mode === "both" ? "·题卷+答案卷" : "·题卷";
  document.title = pbTitle() + suffix;

  // 让浏览器完成一次布局，再弹打印对话框
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}

/* ---------------------------------------------- 启动 */

(async function pbInit() {
  if (typeof renderTopbar === "function") {
    renderTopbar([{ label: "网页出卷" }]);
  }
  pbWireUI();

  const local = pbReadLocal();
  if (local) {
    await pbApplySet(local, "本机已选");
  } else {
    pbInitialEmpty();
    pbSetStatus("本机没有已选题目：可以上传 JSON，或先到题库 / 考点页勾选。");
  }
})();

/* 调试/验证用入口（不影响正常使用） */
window.PB = {
  loadText: (text) => pbLoadText(text, "测试载入"),
  loadLocal: () => {
    const obj = pbReadLocal();
    return obj ? pbApplySet(obj, "本机已选") : Promise.resolve(false);
  },
  render: (mode) => pbRender(mode),
  state: () => ({
    count: pbState.items.length,
    mode: pbState.mode,
    busy: pbState.busy,
  }),
};
