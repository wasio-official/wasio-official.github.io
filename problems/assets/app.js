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

/* ---------------------------------------------- 旧 slug 跳转

   卷改名后 slug 会变（slug = 卷名里的 ASCII 片段 + 卷名哈希），旧链接取
   data/papers/<旧 slug>.json 必然 404。data/aliases.json 记录「旧 slug -> 新 slug」
   （由 rebuild_sitedata.py 每次重推时自动生成），这里在两处生效：

     1. loadPaper() 先查表：命中就拿新 slug 去取数据 —— paper.html?id=
        / question.html?p= / 出卷页的 loadPaper() 全都走这一个口子；
     2. 命中时顺手把地址栏里的 id / p 参数换成新 slug（replaceState，不刷新），
        这样用户复制出去的链接也是新的。

   别名表是可选的增强：文件缺失或解析失败时就是空表，行为与以前完全一致。
   ---------------------------------------------- */

const SLUG_ALIAS_PATH = `${DATA_ROOT}/aliases.json`;

let _slugAliases = null;      // Map<旧 slug, 新 slug>，取到后进程内复用
let _slugAliasesLoad = null;  // 并发去重；失败则清空以便下次重试

/** 拉取并缓存别名表（拿不到就返回空表，绝不抛错） */
function loadSlugAliases() {
  if (_slugAliases) return Promise.resolve(_slugAliases);
  if (_slugAliasesLoad) return _slugAliasesLoad;

  _slugAliasesLoad = fetchJSON(SLUG_ALIAS_PATH)
    .then((raw) => {
      // 兼容两种写法：{ aliases: {...} } 与直接 {...}
      const map = (raw && raw.aliases) || raw || {};
      _slugAliases = new Map(
        Object.keys(map).filter((k) => map[k]).map((k) => [k, String(map[k])])
      );
      return _slugAliases;
    })
    .catch((err) => {
      console.warn(
        "aliases.json 不可用，旧链接跳转未启用：",
        err && err.message ? err.message : err
      );
      _slugAliasesLoad = null;   // 允许下次重试
      return new Map();
    });

  return _slugAliasesLoad;
}

/** 把地址栏里的 id / p 参数从旧 slug 换成新 slug（file:// 或无 history 时静默跳过） */
function rewriteSlugParam(oldSlug, newSlug) {
  try {
    if (typeof history === "undefined" || !history.replaceState) return;
    const u = new URL(location.href);
    let hit = false;
    ["id", "p"].forEach((k) => {
      if (u.searchParams.get(k) === oldSlug) {
        u.searchParams.set(k, newSlug);
        hit = true;
      }
    });
    if (hit) history.replaceState(null, "", u.pathname + u.search + u.hash);
  } catch (e) {
    /* 改不动地址栏不影响页面本身 */
  }
}

/** 旧 slug -> 新 slug；未命中返回原值 */
async function resolveSlug(slug) {
  const key = String(slug ?? "");
  if (!key) return slug;
  const map = await loadSlugAliases();
  const target = map.get(key);
  if (!target) return slug;
  rewriteSlugParam(key, target);
  return target;
}

/** 取单卷数据；旧 slug 会自动落到新卷（见上方「旧 slug 跳转」） */
async function loadPaper(slug) {
  const real = await resolveSlug(slug);
  return fetchJSON(`${DATA_ROOT}/papers/${encodeURIComponent(real)}.json`);
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

/* ---------------------------------------------- 难度徽标

   现在难度是两个独立维度，同时显示：
     difficulty     文字档位（简单/中等/中上/较难）—— 本函数渲染
     score.D        数值难度 0–8                    —— 调用方另加一个 chip
   ---------------------------------------------- */

function difficultyChip(level) {
  // 中上：介于中等与较难之间，用 between 色（见 app.css 的 .chip-midup）
  const map = { 简单: "chip-easy", 中等: "chip-mid", 中上: "chip-midup", 较难: "chip-hard" };
  if (!level) return "";
  const cls = map[level] || "";
  return `<span class="chip ${cls}">${esc(level)}</span>`;
}

/** 数值难度 D 的徽标（0–8；区间写法如 "6-7" 原样显示） */
function difficultyD(value) {
  if (value === null || value === undefined || value === "") return "";
  return `<span class="chip chip-d" title="数值难度 D（0–8）">D ${esc(value)}</span>`;
}

/**
 * 取一道题的数值难度用于展示。
 *
 * 优先 score.D：它是**字符串**，能保留「6-7」这种区间写法（全库 390 题是区间，
 * 例如 OPhO 第 10 届决赛第 1 题 score.D='6-7' 而 difficulty_value=6.0，
 * 后者把区间压成了下限）。
 *
 * 但 score 是「11 维度评分」的可选字段，题库里有 5588 题（约一半）压根没有
 * score —— 这些题**仍然有 difficulty_value**，过去页面直接按 score 有无来决定
 * 显不显示，于是那半数题一个难度徽标都没有。这里退到 difficulty_value 兜底。
 */
function difficultyDOf(item) {
  if (!item) return "";
  const s = item.score;
  if (s && typeof s === "object") {
    const d = s.D;
    if (d !== null && d !== undefined && d !== "") return d;
  }
  const v = item.difficulty_value;
  return v === null || v === undefined ? "" : v;
}

/* ---------------------------------------------- Markdown 渲染

   数据已是规范 Markdown（MinerU 产物）。这里做一层轻量渲染：
   先保护数学公式与图片，再处理块级/行内标记，最后还原。
   公式交给 MathJax，图片原样保留为 <img>。
   ---------------------------------------------- */

const MATH_STASH = [];

/** s[i] 是否被反斜杠转义：前面连续反斜杠个数为奇数即视为转义。
   （用奇偶判断，而不是只看前一个字符，`\\$` 这种「转义的反斜杠 + 美元」
   才不会被误当成转义美元。） */
function isEscaped(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/**
 * 抽出 $...$ 行内公式，换成占位符。
 *
 * ⚠️ 这里**必须**手工扫描，不能用带后行断言（lookbehind）的正则。
 * 旧实现靠 lookbehind 排除「被反斜杠转义的 $」；lookbehind 在
 * Safari / iOS < 16.4、旧 Android WebView 上不被支持，会让**整个 app.js
 * 解析失败**（SyntaxError）→ 站点纯白屏且没有任何提示。
 * 手工扫描语义与旧实现一致：成对、未被转义、不跨行的 $ 才算公式；
 * 转义判断用反斜杠的奇偶（见 isEscaped）。
 */
function stashInlineMath(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && !isEscaped(text, i)) {
      let j = i + 1;
      let end = -1;
      while (j < text.length) {
        const c = text[j];
        if (c === "\n") break; // 公式不跨行
        if (c === "$" && !isEscaped(text, j)) { end = j; break; }
        j++;
      }
      // 公式体必须非空，等价于原正则里的 [^$\n]+?
      if (end > i + 1) {
        MATH_STASH.push({ display: false, body: text.slice(i + 1, end) });
        out += `\u0000M${MATH_STASH.length - 1}\u0000`;
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** 把 $...$ / $$...$$ 抽出来占位，避免被 Markdown 规则破坏 */
function stashMath(text) {
  MATH_STASH.length = 0;
  // 块级公式优先（$$...$$，可以跨行）
  const out = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => {
    MATH_STASH.push({ display: true, body });
    return `\u0000M${MATH_STASH.length - 1}\u0000`;
  });
  // 行内公式（不跨行）
  return stashInlineMath(out);
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

/** 正文里的 HTML 标签白名单。
 *
 * 题库正文由 MinerU 解析而来，有些题的解里面直接用 <table> 排数据表
 * （实测 231 题、<td> 三万多个），化学式用 <sub>/<sup>。这些必须原样放行。
 *
 * 但**不能**放行 <a> <b> <i> <s> <x> <t> <r> 这类单字母名：
 * 题库里有大量写在公式外的数学不等式，如「相距为 d（d<<a）」，
 * 浏览器会把 `<<a` 当成 `<a` 标签开头，一直吞到下一个 `>` ——
 * 题干就是从那里断掉的（2025-兰阶-暑假-第四套 第 7 题实测）。
 */
const MD_ALLOWED_TAG = /^<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|br|hr|sub|sup|img)(?=[\s/>])/i;

/** 已有的 HTML 实体，别二次转义 */
const HTML_ENTITY = /^&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;

/**
 * 转义正文，但放行白名单标签。
 *
 * 手写扫描而不是正则：`<` 要不要转义取决于它后面跟的是什么，
 * 正则做不到「这里放行、那里转义」还不误伤属性。
 */
function escapeKeepTags(s) {
  s = String(s == null ? "" : s);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "<") {
      const rest = s.slice(i);
      if (MD_ALLOWED_TAG.test(rest)) {
        const close = s.indexOf(">", i);
        if (close >= 0) {
          out += s.slice(i, close + 1);
          i = close + 1;
          continue;
        }
      }
      out += "&lt;";
      i += 1;
      continue;
    }
    if (c === ">") {
      out += "&gt;";
      i += 1;
      continue;
    }
    if (c === "&") {
      const rest = s.slice(i);
      out += HTML_ENTITY.test(rest) ? "&" : "&amp;";
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 行内标记：粗体 / 斜体 / 行内代码
 *
 * ⚠️ 进来第一件事必须是 escapeKeepTags()。
 *
 * 这里生成的是要直接塞进 innerHTML 的 HTML 片段，调用方
 * （`<p>${inlineMd(...)}</p>`、`<li>…`、`<h3>…`）都不会再转义一次。
 * 源文本里任何裸的 `<` 都会被浏览器当成标签开始，把后面的内容
 * 一路吞到下一个 `>` —— 实测踩过：某题正文写「相距为 d（d<<a，…）」，
 * `<<a` 被当成 `<a` 标签开头，题干从那里断掉，后面整段消失。
 *
 * 顺序上必须先转义再做标记替换：`<strong>` / `<code>` 这些标签是
 * 我们在替换时生成的，放在转义之后就不会被自己转义掉。
 * 公式体不经过这里（renderMarkdown 已把 $…$ 换成占位符，
 * 还原时 unstashMath 自己做了 esc），所以不用担心数学里的 `<`。
 */
function inlineMd(s) {
  return escapeKeepTags(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // 斜体：原实现用后行断言排除「前导是 * 或单词字符」的情况（见上，老浏览器不支持）；
    // 现在把「前导字符」一起捕获、再在回调里原样还回去，语义等价。
    // 末尾「后面不能再是 *」用的是**前瞻**（lookahead），兼容性没问题，保留。
    .replace(
      /(^|[^*\w])\*([^*\n]+)\*(?!\*)/g,
      (m, pre, body) => pre + "<em>" + body + "</em>"
    )
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
      <img class="brand-word" src="assets/brand-word.png" alt="Wasio">
      <span>Wasio的物理竞赛题库</span>
    </a>
    ${parts ? `<span class="crumb">${parts}</span>` : ""}
    ${topNavHTML()}
  `;
}

/* ---------------------------------------------- 版本号 */

// 版本号：来自 assets/version.js（由 publish.py 从 VERSION 生成）
function initVersion() {
  const el = document.getElementById("site-ver");
  if (!el || typeof window.SITE_VERSION === "undefined") return;
  el.textContent = "v" + window.SITE_VERSION;
  el.hidden = false;
}

// app.js 在各页面 </body> 前加载（此时 DOM 已解析），这里统一在
// DOM ready 时调用一次；避免元素缺失时报错，也不重复绑定。
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVersion, { once: true });
} else {
  initVersion();
}
