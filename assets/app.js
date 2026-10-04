/* ============================================================
   公共工具：数据加载 / Markdown 渲染 / 数学公式排版
   ============================================================ */

/* ---------------------------------------------- 数据访问 */

const DATA_ROOT = "data";

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

let _papersCache = null;
function loadPapers() {
  if (!_papersCache) _papersCache = fetchJSON(`${DATA_ROOT}/papers.json`);
  return _papersCache;
}

function loadPaper(slug) {
  return fetchJSON(`${DATA_ROOT}/papers/${encodeURIComponent(slug)}.json`);
}

/* ---------------------------------------------- URL 参数 */

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

/* ---------------------------------------------- HTML 转义 */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------------------------------------- 标签渲染配置

   ⚠️ 这里是标签展示的**唯一控制点**。
   未来题目标签会新增字段（如 `tag_zh`、`tag_display`、`tag_level` 等），
   届时只需改下面这一段，全站的标签展示会一起生效，无需改各处页面脚本。

   TAG_CONFIG.mode 可选值：
     "leaf"  —— 取路径末级（当前行为）：`力学/刚体转动/转动定律/转动惯量` → `转动惯量`
     "full"  —— 显示完整路径
     "field" —— 优先取 item[ TAGS_CONFIG.field ]，缺失时回退到 "leaf" 行为
   ---------------------------------------------- */

const TAGS_CONFIG = {
  // 展示模式，见上方说明
  mode: "leaf",

  // mode === "field" 时，从题目的哪个字段取标签
  // 预留：未来数据加上该字段后，把 mode 改成 "field" 即可自动启用
  field: "tag_display",

  // 展示上限（0 或 null 表示不限制）
  max: 0,

  // 悬浮提示用哪个值（"full" = 完整路径）
  tooltip: "full",
};

/** 取标签的展示文本 */
function tagLabel(tag) {
  const s = String(tag ?? "");
  if (TAGS_CONFIG.mode === "full") return s;
  return s.split("/").pop();
}

/**
 * 归一化一条标签：支持「字符串」与「对象」两种形态。
 * 对象形态是为未来的新字段预留的 —— 若数据某天变成
 *   { path: "力学/…/转动惯量", tag_display: "转动惯量", tag_zh: "转动惯量" }
 * 这里会自动把展示名与完整路径拆开，页面脚本无需改动。
 */
function normalizeTag(tag) {
  // 纯字符串：按配置推导
  if (typeof tag === "string") {
    return { raw: tag, label: tagLabel(tag) };
  }

  // 对象形态：优先取配置指定的字段
  if (tag && typeof tag === "object") {
    const raw = tag.path || tag.tag || tag.name || tag.full || "";

    // 只有 field 模式才采用新字段；其余模式一律从路径推导，
    // 保证「改 mode」确实能切换展示口径，而不是被数据悄悄改写。
    const preferred =
      TAGS_CONFIG.mode === "field" ? tag[TAGS_CONFIG.field] : null;

    const label =
      (preferred && String(preferred).trim()) ||
      tagLabel(raw) ||
      String(raw);

    return { raw, label, extra: tag };
  }

  return { raw: "", label: "" };
}

/** 取标签的悬浮提示文本 */
function tagTooltip(tag, raw) {
  const s = String(tag ?? "");
  if (TAGS_CONFIG.tooltip === "none") return "";
  return s;
}

/**
 * 渲染一组标签为 HTML。
 * @param {Array<string|object>} tags 标签数组（字符串或对象）
 * @param {object}   [opts]
 * @param {number}   [opts.max]  本处最多显示几个（覆盖全局配置）
 * @param {string}   [opts.empty] 无标签时显示的占位文本
 */
function renderTags(tags, opts = {}) {
  let list = Array.isArray(tags)
    ? tags.map(normalizeTag).filter((t) => t.label)
    : [];

  const max = opts.max ?? TAGS_CONFIG.max;
  if (max > 0) list = list.slice(0, max);

  if (!list.length) {
    return opts.empty
      ? `<span class="tag muted">${esc(opts.empty)}</span>`
      : "";
  }

  return list
    .map(({ raw, label }) => {
      const tip = TAGS_CONFIG.tooltip === "full" ? raw : "";
      const title = tip && tip !== label ? ` title="${esc(tip)}"` : "";
      return `<span class="tag"${title}>${esc(label)}</span>`;
    })
    .join("");
}

/* ---------------------------------------------- 试卷标签（预留）

   试卷级标签是**预留字段**：当前数据里 papers.json 的 `tags` 一律为空数组，
   因此题库页卡片上不显示任何标签，也不会渲染空的标签行。
   将来数据侧补上该字段后，无需改动页面脚本，标签会自动出现。

   与题目标签（TAGS_CONFIG）刻意分开，便于两者各自独立控制。
   ---------------------------------------------- */

const PAPER_TAGS_CONFIG = {
  max: 3,       // 卡片上最多显示几个（0 = 不限）
  search: true, // 是否让试卷标签参与题库页搜索（字段为空时无影响）
};

/* ---------------------------------------------- 难度徽标 */

function difficultyChip(level) {
  const map = { 简单: "chip-easy", 中等: "chip-mid", 较难: "chip-hard" };
  if (!level) return "";
  const cls = map[level] || "";
  return `<span class="chip ${cls}">${esc(level)}</span>`;
}

/* ---------------------------------------------- Markdown 渲染

   数据已是规范 Markdown（MinerU 产物）。这里做一层轻量渲染：
   先保护数学公式与图片，再处理块级/行内标记，最后还原。
   公式交给 MathJax，图片原样保留为 <img>。
   ---------------------------------------------- */

const MATH_STASH = [];

/** 把 $...$ / $$...$$ 抽出来占位，避免被 Markdown 规则破坏 */
function stashMath(text) {
  MATH_STASH.length = 0;
  // 块级公式优先
  let out = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => {
    MATH_STASH.push({ display: true, body });
    return `\u0000M${MATH_STASH.length - 1}\u0000`;
  });
  // 行内公式（避免跨越空行）
  out = out.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_, body) => {
    MATH_STASH.push({ display: false, body });
    return `\u0000M${MATH_STASH.length - 1}\u0000`;
  });
  return out;
}

function unstashMath(html) {
  return html.replace(/\u0000M(\d+)\u0000/g, (_, i) => {
    const m = MATH_STASH[Number(i)];
    if (!m) return "";
    // 还原成 MathJax 识别的定界符，交给 typesetPromise 处理
    return m.display
      ? `<div class="math-block">\\[${esc(m.body)}\\]</div>`
      : `\\(${esc(m.body)}\\)`;
  });
}

/** 行内标记：粗体 / 斜体 / 行内代码 */
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");
}

/** 完整的 Markdown → HTML */
function renderMarkdown(src) {
  if (!src) return "";
  let text = String(src).replace(/\r\n?/g, "\n");

  text = stashMath(text);

  const lines = text.split("\n");
  const out = [];
  let para = [];
  let listType = null; // "ul" | "ol"
  let inFence = false;
  let fenceBuf = [];
  let quoteBuf = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quoteBuf.length) {
      out.push(`<blockquote>${inlineMd(quoteBuf.join(" "))}</blockquote>`);
      quoteBuf = [];
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw;

    // 代码围栏
    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push(`<pre><code>${esc(fenceBuf.join("\n"))}</code></pre>`);
        fenceBuf = [];
        inFence = false;
      } else {
        flushAll();
        inFence = true;
      }
      continue;
    }
    if (inFence) { fenceBuf.push(line); continue; }

    // 空行
    if (!line.trim()) { flushAll(); continue; }

    // 独立成行的图片
    const imgOnly = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgOnly) {
      flushAll();
      out.push(
        `<img src="${esc(imgOnly[2])}" alt="${esc(imgOnly[1])}" loading="lazy">`
      );
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lv = Math.min(h[1].length + 1, 6); // 内容内标题整体降一级
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && !/^\s*[-*+]\s/.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }

    // 引用
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quoteBuf.push(q[1]); continue; }
    flushQuote();

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (listType !== want) { flushList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      continue;
    }
    flushList();

    // 行内图片（夹杂在文字中）
    para.push(
      line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
        (_, alt, src) => `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">`)
    );
  }

  if (inFence && fenceBuf.length) {
    out.push(`<pre><code>${esc(fenceBuf.join("\n"))}</code></pre>`);
  }
  flushAll();

  return unstashMath(out.join("\n"));
}

/* ---------------------------------------------- MathJax 排版 */

let _mathReady = null;

/** 等待 MathJax 就绪（若加载失败则静默降级） */
function mathReady() {
  if (_mathReady) return _mathReady;
  _mathReady = new Promise((resolve) => {
    if (window.MathJax && window.MathJax.typesetPromise) return resolve(true);
    let waited = 0;
    const timer = setInterval(() => {
      if (window.MathJax && window.MathJax.typesetPromise) {
        clearInterval(timer);
        resolve(true);
      } else if ((waited += 100) > 8000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
  return _mathReady;
}

/** 对节点内公式排版 */
async function typeset(el) {
  const ok = await mathReady();
  if (!ok || !el) return;
  try {
    await window.MathJax.typesetPromise([el]);
  } catch (e) {
    console.warn("MathJax 排版失败：", e);
  }
}

/* ---------------------------------------------- 折叠面板 */

function setupCollapsible(root = document) {
  root.querySelectorAll(".panel.collapsible .panel-head").forEach((head) => {
    head.addEventListener("click", () => {
      const panel = head.closest(".panel");
      const open = panel.classList.toggle("open");
      const badge = head.querySelector(".lock-badge");
      if (badge) badge.textContent = open ? "已展开" : "已隐藏";
      if (open) typeset(panel.querySelector(".panel-body"));
    });
  });
}

/* ---------------------------------------------- 顶栏 */

/** 顶栏右侧的固定页面入口；当前页面对应项高亮 */
function topNavHTML() {
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const items = [
    { label: "题库", href: "library.html" },
    { label: "考点", href: "tags.html" },
  ];
  return `<nav class="topnav">${items
    .map((it) => {
      const active = here === it.href.toLowerCase() ? ' class="is-active"' : "";
      return `<a href="${esc(it.href)}"${active}>${esc(it.label)}</a>`;
    })
    .join("")}</nav>`;
}

function renderTopbar(crumbs = []) {
  const bar = document.querySelector(".topbar-inner");
  if (!bar) return;
  const parts = crumbs
    .map((c) =>
      c.href
        ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
        : `<span>${esc(c.label)}</span>`
    )
    .join('<span class="crumb-sep">/</span>');

  bar.innerHTML = `
    <a class="brand" href="index.html">
      <span class="brand-mark">Φ</span>
      <span>物理竞赛题库</span>
    </a>
    ${parts ? `<span class="crumb">${parts}</span>` : ""}
    ${topNavHTML()}
  `;
}
