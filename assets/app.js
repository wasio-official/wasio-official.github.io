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
    <span class="topbar-spacer"></span>
    ${parts ? `<span class="crumb">${parts}</span>` : ""}
  `;
}
