/* ============================================================
   网页出卷：把一份 paperset（wasio-paperset）渲染成 A4 文档，
   既可「一键下载 PDF 文件」，也可继续用浏览器打印。
   ------------------------------------------------------------
   设计要点（与「出卷版式规范.md」保持观感一致）：
   - 全程在浏览器里完成：读本地 JSON → fetch 题目 → 渲染 → 分页 →
     （直接下载：html2canvas 逐页截图 → jsPDF 写 A4 → doc.save）
     或（打印：window.print）。**没有上传、没有后端、不会写进仓库或站点任何目录。**
   - 两个第三方库都自托管在 assets/vendor/，本地引用、不走 CDN：
       jspdf.umd.min.js       jsPDF 2.5.2（jsDelivr npm 包 dist/jspdf.umd.min.js）
       html2canvas.min.js     html2canvas 1.4.1（jsDelivr npm 包 dist/html2canvas.min.js）
   - 版式是「先分页、再画」：题目先渲染成独立块，量出真实高度后贪心装箱进
     固定 210mm × 297mm 的 .pg-sheet；分页只发生在题目 / 段落边界，
     不会把一行字切断（超高题在段落边界续页，见 pbSplitBlock）。
   - 题卷默认一题一页；题干 < 350 字且图片 ≤ 2 的短题不强制分页，允许自然连排。
   - 答案卷自然连排；只排题干 + 「解析：」，不排末尾「答案：」。
   - 正文（含图片）严格按源数据顺序渲染：这里**不做任何图片重排**。
     图片位置由题库数据本身决定，渲染层只负责把相对路径补成
     data/images/<slug>/... 并保证尺寸 / 加载失败占位。
   - 环境不支持直接生成（缺库 / canvas 跨域 / 内存受限）时自动降级：
     给出可见提示，打印按钮照常可用。
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

/** 所有动作按钮：下载（主）与打印（备选）；页面上缺哪个就跳过哪个 */
const PB_BTN_IDS = [
  "pg-dl-q", "pg-dl-a", "pg-dl-both",
  "pg-print-q", "pg-print-a", "pg-print-both",
];

function pbEnableButtons(on) {
  PB_BTN_IDS.forEach((id) => {
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

/* ---------------------------------------------- 页式排版：先分页，再画 */

/**
 * A4 页容器：210mm × 297mm，版心左右 16mm、上下 18mm（与 @page 的打印边距一致）。
 * 分页规则：
 *   - 题卷：非短题（不是 .q-short）强制独占一页，前后都断开；短题允许连排；
 *   - 答案卷：自然连排，只在题目 / 段落 / 公式块 / 图片边界断开；
 *   - 单块高过一页时在段落边界续页（pbSplitBlock），绝不切断一行字。
 */
const PB_PAGE = { w: 210, h: 297, padX: 16, padY: 18 };
const PB_CONTENT_W = PB_PAGE.w - PB_PAGE.padX * 2; // 178mm
const PB_CONTENT_H = PB_PAGE.h - PB_PAGE.padY * 2; // 261mm
const PB_CAPTURE_SCALE = 2;      // html2canvas 倍率：清晰度 / 体积的折中
const PB_JPEG_QUALITY = 0.92;    // 图像型 PDF 每页的 JPEG 质量

/** 1mm 等于多少 CSS 像素；量不出来（无布局环境）就按 96dpi 折算 */
function pbPxPerMm() {
  if (pbPxPerMm.cache) return pbPxPerMm.cache;
  let mm = 0;
  try {
    if (document.createElement && document.body) {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;width:100mm;height:0;visibility:hidden;";
      document.body.appendChild(probe);
      if (probe.getBoundingClientRect) mm = probe.getBoundingClientRect().width / 100;
      document.body.removeChild(probe);
    }
  } catch (err) { mm = 0; }
  pbPxPerMm.cache = mm > 0 ? mm : 96 / 25.4;
  return pbPxPerMm.cache;
}

/** 版心可用高度（px） */
function pbUsableHeightPx() {
  return PB_CONTENT_H * pbPxPerMm();
}

/* 无布局环境（Node 垫片 / 极老的 WebView）里的高度估算：
   按 15px 字号、1.8 行高、178mm 版心估算行数；图片按常见扫描图 260px 计。
   真浏览器一律走 getBoundingClientRect，不会用到这里。 */
const PB_EST = {
  linePx: 27,      // 15px × 1.8
  perLine: 43,     // 178mm ÷ 15px ≈ 44.8，取 43 偏保守
  imgPx: 260,
  gapPx: 8,
  itemGapPx: 18,
  headPx: 150,
  ansGapPx: 14,
};

function pbTextUnits(text) {
  const s = String(text || "");
  let u = 0;
  for (let i = 0; i < s.length; i++) {
    u += s.charCodeAt(i) > 0x2e7f ? 1 : 0.52; // 中日韩全角 ≈ 1em，西文 ≈ 0.52em
  }
  return u;
}

function pbEstimateHeight(el) {
  if (!el || el.nodeType !== 1) return 0;
  if (el.classList && el.classList.contains("sheet-head")) return PB_EST.headPx;
  const units = pbTextUnits(el.textContent);
  const lines = Math.max(1, Math.ceil(units / PB_EST.perLine));
  let h = lines * PB_EST.linePx;
  const count = (sel) => (el.querySelectorAll ? el.querySelectorAll(sel).length : 0);
  h += count("img") * PB_EST.imgPx;
  h += count("p, li, div.math-block, blockquote, table, pre, h1, h2, h3, h4, h5, h6, hr") * PB_EST.gapPx;
  if (el.classList) {
    if (el.classList.contains("q-item")) h += PB_EST.itemGapPx;
    if (el.classList.contains("q-ans")) h += PB_EST.ansGapPx;
  }
  return h;
}

/** 元素上下外边距之和（px）；无 getComputedStyle 时返回 0 */
function pbMargins(el) {
  let m = 0;
  try {
    const gcs = typeof window !== "undefined" && window.getComputedStyle;
    if (!gcs) return 0;
    const cs = gcs.call(window, el);
    m = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  } catch (err) { m = 0; }
  return m;
}

/** 单个块的实测高度（含上下外边距）；没有布局时退回估算 */
function pbMeasureBox(el) {
  if (!el) return 0;
  let h = 0;
  try {
    if (el.getBoundingClientRect) h = el.getBoundingClientRect().height;
  } catch (err) { h = 0; }
  if (!(h > 0) && typeof el.scrollHeight === "number") h = el.scrollHeight;
  if (!(h > 0)) return pbEstimateHeight(el);
  return h + pbMargins(el);
}

/** 当前环境有没有真实布局（无浏览器 DOM 垫片时没有） */
function pbHasLayout() {
  try {
    const body = document.body;
    return !!(body && body.getBoundingClientRect && body.getBoundingClientRect().width > 0);
  } catch (err) { return false; }
}

/** 把块临时挂回测量容器再量（新拆出来的续页块需要先布局） */
function pbMountAndMeasure(el, staging) {
  if (staging && el && el.parentNode !== staging) staging.appendChild(el);
  return pbMeasureBox(el);
}

/* ---- 超高块：按段落 / 公式块 / 图片 / 列表 / 表格边界拆开 ---- */

const PB_ATOM_SEL =
  "p, pre, blockquote, ul, ol, table, div.math-block, img, h1, h2, h3, h4, h5, h6, hr";

/** 块内可独立搬动的「原子块」：自己属于原子选择器，且没有被别的原子块包住 */
function pbFlowAtoms(root) {
  const out = [];
  const list = root.querySelectorAll ? root.querySelectorAll(PB_ATOM_SEL) : [];
  Array.prototype.forEach.call(list, (node) => {
    let p = node.parentNode;
    while (p && p !== root) {
      if (p.nodeType === 1 && p.matches && p.matches(PB_ATOM_SEL)) return;
      p = p.parentNode;
    }
    out.push(node);
  });
  return out;
}

/** 块里有没有不属于任何原子块的散文字（有就不拆，避免丢内容） */
function pbHasLooseText(root, atoms) {
  const doc = root.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== "function") return false;
  const atomset = new Set(atoms);
  let tw;
  try {
    tw = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null);
  } catch (err) {
    return false;
  }
  while (tw.nextNode()) {
    const t = tw.currentNode;
    if (!/\S/.test(t.data || "")) continue;
    let p = t.parentNode;
    while (p && p !== root) {
      if (atomset.has(p)) break;
      p = p.parentNode;
    }
    if (p === root) return true;
  }
  return false;
}

function pbCloneEmpty(el) {
  const c = el.cloneNode(false);
  while (c.firstChild) c.removeChild(c.firstChild);
  return c;
}

/**
 * 用一组原子块重建一块。
 * 注意：root 本身不参与复用 —— 先浅克隆一个空壳，再把原子块搬进去，
 * 这样 root 里其余原子块的祖先链保持完整，后续分块还能继续按原结构重建。
 */
function pbBuildChunk(root, atoms, idxList, isFirst) {
  const host = pbCloneEmpty(root);
  if (!isFirst && host.classList) host.classList.add("q-cont");

  const map = new Map();
  idxList.forEach((i) => {
    const atom = atoms[i];
    const chain = [];
    let p = atom.parentNode;
    while (p && p !== root) { chain.unshift(p); p = p.parentNode; }

    let parent = host;
    chain.forEach((anc) => {
      let c = map.get(anc);
      if (!c) {
        c = pbCloneEmpty(anc);
        map.set(anc, c);
        parent.appendChild(c);
      }
      parent = c;
    });
    parent.appendChild(atom);
  });
  return host;
}

/** 把过高的一块按原子块边界拆成若干块；拆不动就原样返回 */
function pbSplitBlock(el, maxH) {
  const atoms = pbFlowAtoms(el);
  if (atoms.length < 2) return [el];
  if (pbHasLooseText(el, atoms)) return [el];

  const heights = atoms.map(pbMeasureBox);
  const total = heights.reduce((a, b) => a + b, 0);
  const itemH = pbMeasureBox(el);

  // 块自身还有「题间距 / 答案分隔线 / 段落间距」等固定开销；
  // 按整块的 实测高度-原子高度和 预留出来，保证每块装完不超版心。
  const overhead = Math.max(0, itemH - total);
  const budget = Math.max(1, maxH - overhead);

  const groups = [];
  let cur = [];
  let curH = 0;
  heights.forEach((h, i) => {
    if (cur.length && curH + h > budget) {
      groups.push(cur);
      cur = [];
      curH = 0;
    }
    cur.push(i);
    curH += h;
  });
  if (cur.length) groups.push(cur);
  if (groups.length < 2) return [el];
  return groups.map((idxs, gi) => pbBuildChunk(el, atoms, idxs, gi === 0));
}

/* ---- 贪心装箱 ---- */

function pbNewSheet(part) {
  const sheet = document.createElement("section");
  sheet.className = "pg-sheet";
  if (part && part.kind) sheet.dataset.kind = part.kind;
  return sheet;
}

/**
 * 把 part.header + part.items 装进若干 .pg-sheet。
 * 返回 sheet 数组（DOM 已经填好内容，供调用方包一层预览外框）。
 */
function pbPackPart(part, maxH, staging) {
  const sheets = [];
  let sheet = null;
  let used = 0;

  const openSheet = () => {
    sheet = pbNewSheet(part);
    sheets.push(sheet);
    used = 0;
  };
  const place = (el, h, label) => {
    if (used > 0 && used + h > maxH) openSheet();
    sheet.appendChild(el);
    used += h;
    if (used > maxH + 0.5) {
      // 单个原子块本身就超过一页（例如一整段超长解析 / 超大图）：留下一句日志，
      // 截图时靠 .pg-sheet 的 overflow:hidden 裁剪，不至于把整页布局搞乱。
      console.warn(
        "[pdfbuild] 单块超过一页可用高度，无法再按边界拆分：",
        label || (el.className || el.localName),
        Math.round(used) + "/" + Math.round(maxH)
      );
    }
  };

  openSheet();
  if (part.header) {
    const hh = pbMeasureBox(part.header);
    sheet.appendChild(part.header);
    used = hh;
  }

  // 超高块按段落边界续页；续页里若还有超高块，最多再拆两层
  const placeBlock = (el, depth, label, roomSplit) => {
    const h = pbMountAndMeasure(el, staging);
    // 卷头独占一页会很浪费：第一页只有标题时，把首题按「剩余高度」拆开接在卷头下面
    const headerOnly =
      used > 0 && !!sheet.querySelector(".sheet-head") && !sheet.querySelector(".q-item");
    // 答案卷是自然连排：放不下当前页剩余空间时，在段落边界续页（排版效果接近打印）
    const naturalSplit = !!roomSplit && used > 0 && h > maxH - used + 0.5;
    const limit = headerOnly || naturalSplit
      ? Math.max(1, (maxH - used) * 0.95)
      : maxH;

    if (h > limit + 0.5 && depth < 3 && (headerOnly || naturalSplit || h > maxH + 0.5)) {
      let subs = pbSplitBlock(el, limit);
      // 实测高度含外边距时估值可能偏乐观；再收紧一档重试一次
      if (subs.length < 2) subs = pbSplitBlock(el, limit * 0.8);
      if (subs.length > 1) {
        subs.forEach((s) => placeBlock(s, depth + 1, label, false));
        return;
      }
    }
    place(el, h, label);
  };

  let forceBreak = false;
  part.items.forEach((it) => {
    if (forceBreak && used > 0) openSheet();
    forceBreak = false;

    placeBlock(it.el, 0, it.item && it.item.qid, part.kind !== "questions");

    // 题卷：长题（非 q-short）一题一页；短题允许继续连排
    if (part.kind === "questions" && !it.short) forceBreak = true;
  });

  if (!sheets.length) sheets.push(pbNewSheet(part));
  return sheets;
}

/**
 * 真浏览器里按实际布局复核一遍：若某页 scrollHeight 真的溢出，
 * 就把最后一块顺延到下一页，避免 overflow:hidden 把内容切掉。
 * 无布局环境（DOM 垫片）直接跳过。
 */
function pbVerifySheets(paper) {
  if (!paper || !paper.querySelectorAll || !pbHasLayout()) return;
  const parts = Array.prototype.slice.call(paper.querySelectorAll(".paper-part"));
  parts.forEach((part) => {
    for (let pass = 0; pass < 6; pass++) {
      let fixed = false;
      const sheets = Array.prototype.slice.call(part.querySelectorAll(".pg-sheet"));
      for (let i = 0; i < sheets.length; i++) {
        const sheet = sheets[i];
        const scroll = typeof sheet.scrollHeight === "number" ? sheet.scrollHeight : 0;
        const client = typeof sheet.clientHeight === "number" ? sheet.clientHeight : 0;
        // 容 8px：亚像素 / 外边距的小溢出只压到页边距里，不至于触发无谓的挪页
        if (!client || scroll <= client + 8) continue;

        const kids = Array.prototype.slice.call(sheet.childNodes).filter(
          (n) => n.nodeType === 1 && !(n.classList && n.classList.contains("sheet-head"))
        );
        if (kids.length < 2) continue; // 只剩一块：它本身就超高，挪页也放不下
        const last = kids[kids.length - 1];
        const wrap = sheet.parentNode;

        let nextWrap = wrap.nextSibling;
        while (nextWrap && nextWrap.nodeType !== 1) nextWrap = nextWrap.nextSibling;
        let target = null;
        if (nextWrap && nextWrap.classList && nextWrap.classList.contains("pg-sheet-wrap")) {
          target = nextWrap.querySelector(".pg-sheet");
        }
        if (!target) {
          const nw = document.createElement("div");
          nw.className = "pg-sheet-wrap";
          target = pbNewSheet(part);
          nw.appendChild(target);
          if (wrap.parentNode) wrap.parentNode.insertBefore(nw, wrap.nextSibling);
        }
        target.insertBefore(last, target.firstChild);
        fixed = true;
      }
      if (!fixed) break;
    }
  });
}

/** 窄屏预览：只缩放外层 .pg-pages，.pg-sheet 始终保持 A4 真实尺寸（截图才准） */
function pbFitScale() {
  const outer = pbEl("paper");
  if (!outer || !pbHasLayout()) return;
  const inner = outer.querySelector(".pg-pages");
  const wrap = inner ? inner.querySelector(".pg-sheet-wrap") : null;
  if (!inner || !wrap) return;

  inner.style.transform = "";
  outer.classList.remove("is-scaled");
  outer.style.height = "";

  const sheetW = wrap.getBoundingClientRect().width;
  const avail = outer.clientWidth;
  if (!sheetW || !avail) return;
  const k = Math.min(1, avail / sheetW);
  if (k >= 0.999) return;

  const naturalH = inner.getBoundingClientRect().height;
  inner.style.transform = "scale(" + k.toFixed(4) + ")";
  outer.classList.add("is-scaled");
  outer.style.height = Math.ceil(naturalH * k + 24) + "px";
}

let pbScaleTimer = 0;
function pbWireResize() {
  if (typeof window.addEventListener !== "function") return;
  window.addEventListener("resize", () => {
    if (pbScaleTimer) clearTimeout(pbScaleTimer);
    pbScaleTimer = setTimeout(() => { pbFitScale(); }, 150);
  });
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

/** 「解析：」段落：标签加粗，跟在第一段开头 */
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
    // 只排解析，不排「答案：」段。
    // 用户要的是「题干 + 解析」，末尾那句最终答案先不印（他还要统改答案）。
    // 想恢复的话，把下面这一行取消注释即可。
    // const answer = pbAnswerSection(q.answer, item.slug, "答案");
    const analysis = pbAnswerSection(q.analysis, item.slug, "解析");
    if (analysis) { box.appendChild(analysis); added++; }
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

/** 生成一「部分」（题卷 / 答案卷）的卷头与独立题块，供分页使用 */
function pbBuildPart(kind, title, subtitle, duration) {
  const part = {
    kind,
    header: pbHeader(kind, title, subtitle, duration, pbState.items.length),
    items: [],
  };
  pbState.items.forEach((item, i) => {
    const el = pbBuildItem(item, i, kind);
    part.items.push({
      el,
      item,
      // 只有题卷参与「短题连排」；答案卷一律自然连排
      short: kind === "questions" && el.classList.contains("q-short"),
    });
  });
  return part;
}

/**
 * 清空并渲染指定模式：先在不可见容器里生成独立题块，
 * 等图片 + MathJax 就绪、量出真实高度后贪心分页，
 * 最后把 .pg-sheet 挂回预览区。
 */
async function pbRender(mode) {
  const paper = pbEl("paper");
  if (!paper) return;

  pbState.mode = mode;
  if (!pbState.items.length) {
    pbInitialEmpty();
    return;
  }

  const title = pbTitle();
  const subtitle = String((pbEl("pg-subtitle") || {}).value || "").trim();
  const duration = Number((pbEl("pg-duration") || {}).value) || 0;

  paper.innerHTML = "";
  paper.dataset.mode = mode;
  paper.classList.remove("is-scaled");
  paper.style.height = "";

  // ① 不可见测量容器：宽度与 .pg-sheet 的版心一致（178mm）
  const staging = document.createElement("div");
  staging.className = "pg-staging";
  paper.appendChild(staging);

  const parts = [];
  if (mode === "questions" || mode === "both") {
    parts.push(pbBuildPart("questions", title, subtitle, duration));
  }
  if (mode === "answers" || mode === "both") {
    parts.push(pbBuildPart("answers", title, subtitle, duration));
  }
  parts.forEach((part) => {
    staging.appendChild(part.header);
    part.items.forEach((it) => staging.appendChild(it.el));
  });

  await pbWaitImages(staging);
  // MathJax 排版完成前不允许打印 —— 否则打印出来是原始 \(...\) 源码
  await pbTypeset(staging);

  // ② 量高 + 贪心装箱（题卷长题独占一页、短题连排；答案卷自然分页）
  const maxH = pbUsableHeightPx();
  const pages = document.createElement("div");
  pages.className = "pg-pages";
  parts.forEach((part) => {
    const sheets = pbPackPart(part, maxH, staging);
    const partEl = document.createElement("section");
    partEl.className = "paper-part part-" + part.kind;
    partEl.dataset.kind = part.kind;
    sheets.forEach((sheet) => {
      const wrap = document.createElement("div");
      wrap.className = "pg-sheet-wrap";
      wrap.appendChild(sheet);
      partEl.appendChild(wrap);
    });
    pages.appendChild(partEl);
  });

  if (staging.parentNode) staging.parentNode.removeChild(staging);
  paper.appendChild(pages);

  // ③ 真浏览器里按实际布局复核；再按屏幕宽度缩放预览
  pbVerifySheets(paper);
  pbFitScale();
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
  // 「下载 PDF」是主按钮；「打印」保留为备选（文字可选中、质量更高）
  const dlq = pbEl("pg-dl-q");
  const dla = pbEl("pg-dl-a");
  const dlb = pbEl("pg-dl-both");
  if (dlq) dlq.addEventListener("click", () => pbDownloadPDF("questions"));
  if (dla) dla.addEventListener("click", () => pbDownloadPDF("answers"));
  if (dlb) dlb.addEventListener("click", () => pbDownloadPDF("both"));

  const q = pbEl("pg-print-q");
  const a = pbEl("pg-print-a");
  const both = pbEl("pg-print-both");
  if (q) q.addEventListener("click", () => pbPrint("questions"));
  if (a) a.addEventListener("click", () => pbPrint("answers"));
  if (both) both.addEventListener("click", () => pbPrint("both"));

  pbWireResize();

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
  document.title = pbTitle() + pbModeSuffix(mode);

  // 让浏览器完成一次布局，再弹打印对话框
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}

/* ---------------------------------------------- 直接下载 PDF */

/** 卷别后缀：与下载文件名保持一致 */
function pbModeSuffix(mode) {
  return mode === "answers" ? "·答案卷" : mode === "both" ? "·试卷" : "·题卷";
}

/** 文件名里的非法字符替换掉；标题过长时截短，避免超过文件系统上限 */
function pbFileName(mode) {
  const raw = String(pbTitle() || "").trim();
  const safe = Array.from(
    raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim()
  ).slice(0, 80).join("");
  return (safe || "未命名试卷") + pbModeSuffix(mode) + ".pdf";
}

/** 自托管库是否都就绪：jsPDF 的 UMD 挂在 window.jspdf.jsPDF */
function pbLibCheck() {
  const h2c = typeof window !== "undefined" ? window.html2canvas : null;
  const PDF = typeof window !== "undefined" && window.jspdf ? window.jspdf.jsPDF : null;
  if (typeof h2c !== "function" || typeof PDF !== "function") return null;
  return { h2c, PDF };
}

/** 进度提示（生成期间显示「正在生成 2/4 页…」） */
function pbSetProgress(text) {
  const el = pbEl("pg-progress");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

/** 等两帧，让浏览器把「正在生成…」和页面状态画出来 */
function pbNextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/** 截图前把预览缩放恢复成 1:1，保证 html2canvas 抓到的是 A4 真实尺寸 */
function pbPrepareCapture() {
  const paper = pbEl("paper");
  const inner = paper ? paper.querySelector(".pg-pages") : null;
  document.body.classList.add("pg-capturing");
  if (paper) {
    paper.classList.remove("is-scaled");
    paper.style.height = "";
  }
  if (inner) inner.style.transform = "";
  pbHideAssistiveMml(true);
}

/**
 * 隐藏 / 恢复 MathJax 的无障碍 MathML 副本。
 *
 * MathJax 会给每个公式放一份 <mjx-assistive-mml>（屏幕阅读器用），靠
 * `clip: rect(1px,1px,1px,1px)` 藏起来；但 html2canvas 不认这种裁剪，
 * 会把它一起画到画布上，于是公式出现「字形叠字形」的重影（实测踩过）。
 * 光靠 CSS 不保险（MathJax 自己的样式表优先级更高），所以截图前后用内联
 * `!important` 直接开关。
 */
function pbHideAssistiveMml(hide) {
  if (!document.querySelectorAll) return;
  const nodes = document.querySelectorAll("mjx-assistive-mml");
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (!n || !n.style) continue;
    if (hide) {
      if (!n.hasAttribute("data-pb-prev-display")) {
        n.setAttribute("data-pb-prev-display", n.style.display || "block");
      }
      n.style.setProperty("display", "none", "important");
    } else {
      n.style.removeProperty("display");
    }
  }
}

function pbEndCapture() {
  document.body.classList.remove("pg-capturing");
  pbHideAssistiveMml(false);
  pbFitScale();
}

/** 一页 .pg-sheet → JPEG dataURL；失败时打上 pbFallback，交给上层降级 */
async function pbSheetToImage(sheet, h2c) {
  let canvas = null;
  try {
    canvas = await h2c(sheet, {
      scale: PB_CAPTURE_SCALE,
      backgroundColor: "#ffffff",
      logging: false,
      useCORS: false,
      allowTaint: false,
    });
  } catch (err) {
    const e = new Error("页面截取失败：" + (err && err.message ? err.message : err));
    e.pbFallback = true;
    throw e;
  }
  if (!canvas || typeof canvas.toDataURL !== "function") {
    const e = new Error("页面截取没有返回画布");
    e.pbFallback = true;
    throw e;
  }

  let url = "";
  try {
    url = canvas.toDataURL("image/jpeg", PB_JPEG_QUALITY);
  } catch (err) {
    // 某些 WebView 会因跨域 / 内存限制让 canvas 被标记为 tainted
    const e = new Error("canvas.toDataURL 失败（WebView 可能限制跨域或内存）");
    e.pbFallback = true;
    throw e;
  }
  if (!url || url.indexOf("data:image") !== 0) {
    const e = new Error("画布导出为空");
    e.pbFallback = true;
    throw e;
  }
  return url;
}

/** 自动降级：明确告诉用户改用打印，并把打印按钮标出来 */
function pbDowngradeNotice(detail) {
  const msg =
    "当前环境不支持直接生成 PDF，请用「打印」方式保存（打印版文字可选中、质量更高）。" +
    (detail ? "（" + detail + "）" : "");
  pbNotice(msg, "err");
  pbSetStatus("直接下载不可用：请点下方「打印」按钮，在打印对话框里选「另存为 PDF」。");
  pbSetProgress("");
  ["pg-print-q", "pg-print-a", "pg-print-both"].forEach((id) => {
    const b = pbEl(id);
    if (b) b.classList.add("pg-print-hint");
  });
}

/**
 * 直接生成并下载 PDF：逐页 html2canvas → JPEG → jsPDF 写入 A4 → doc.save。
 * 不经过打印对话框；不产生任何上传或外部请求。
 */
async function pbDownloadPDF(mode) {
  if (pbState.busy) return;
  if (!pbState.items.length) {
    pbNotice("还没有可下载的题目", "err");
    return;
  }

  const libs = pbLibCheck();
  if (!libs) {
    pbDowngradeNotice("html2canvas / jsPDF 未加载成功");
    return;
  }

  const keepTitle = document.title;
  pbSetBusy(true);
  try {
    pbSetProgress("正在排版…");
    await pbRender(mode);

    const sheets = Array.prototype.slice.call(
      (pbEl("paper") || document).querySelectorAll(".pg-sheet")
    );
    if (!sheets.length) throw new Error("没有生成任何页面");

    pbPrepareCapture();
    await pbNextFrame();

    let doc = null;
    try {
      doc = new libs.PDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
    } catch (err) {
      const e = new Error("PDF 组件初始化失败：" + (err && err.message ? err.message : err));
      e.pbFallback = true;
      throw e;
    }

    for (let i = 0; i < sheets.length; i++) {
      pbSetProgress("正在生成 " + (i + 1) + "/" + sheets.length + " 页…");
      await pbNextFrame();
      const data = await pbSheetToImage(sheets[i], libs.h2c);
      if (i > 0) doc.addPage("a4", "portrait");
      doc.addImage(data, "JPEG", 0, 0, PB_PAGE.w, PB_PAGE.h, undefined, "FAST");
    }

    const name = pbFileName(mode);
    try {
      doc.save(name);
    } catch (err) {
      const e = new Error("浏览器阻止了文件保存：" + (err && err.message ? err.message : err));
      e.pbFallback = true;
      throw e;
    }
    pbSetProgress("");
    pbSetStatus("已下载 " + name + "（共 " + sheets.length + " 页）");
    pbNotice("PDF 已生成：" + name + "，已开始下载。", "ok");
  } catch (err) {
    console.error("[pdfbuild] 直接生成 PDF 失败：", err);
    pbSetProgress("");
    if (err && err.pbFallback) pbDowngradeNotice(err.message);
    else pbNotice("生成 PDF 失败：" + (err && err.message ? err.message : err), "err");
  } finally {
    pbEndCapture();
    pbSetBusy(false);
    document.title = keepTitle;
  }
}

/* ---------------------------------------------- 启动 */

(async function pbInit() {
  if (typeof renderTopbar === "function") {
    renderTopbar([{ label: "网页出卷" }]);
  }
  pbWireUI();

  // 库缺失时不阻塞出卷：打印照常可用，点「下载」时会给出明确降级提示
  if (!pbLibCheck()) {
    const note = pbEl("pg-dl-note");
    if (note) note.textContent = "当前环境没有加载 PDF 生成组件，请用下方「打印」方式保存。";
  }

  const local = pbReadLocal();
  if (local) {
    await pbApplySet(local, "本机已选");
  } else {
    pbInitialEmpty();
    pbSetStatus("本机没有已选题目：可以上传 JSON，或先到题库 / 考点页勾选。");
  }
})();

/** 分页报告：每页的块数与实测内容高度，供调试 / 无浏览器测试断言用 */
function pbPageReport() {
  const paper = pbEl("paper");
  const maxH = pbUsableHeightPx();
  const pages = [];
  if (!paper || !paper.querySelectorAll) return pages;
  Array.prototype.forEach.call(paper.querySelectorAll(".paper-part"), (part) => {
    Array.prototype.forEach.call(part.querySelectorAll(".pg-sheet"), (sheet, i) => {
      let used = 0;
      let blocks = 0;
      Array.prototype.forEach.call(sheet.childNodes, (n) => {
        if (n.nodeType !== 1) return;
        used += pbMeasureBox(n);
        blocks++;
      });
      pages.push({
        kind: part.dataset.kind || "",
        index: i,
        blocks,
        used: Math.round(used),
        max: Math.round(maxH),
        overflow: used > maxH + 1,
      });
    });
  });
  return pages;
}

/* 调试/验证用入口（不影响正常使用） */
window.PB = {
  loadText: (text) => pbLoadText(text, "测试载入"),
  loadLocal: () => {
    const obj = pbReadLocal();
    return obj ? pbApplySet(obj, "本机已选") : Promise.resolve(false);
  },
  render: (mode) => pbRender(mode),
  download: (mode) => pbDownloadPDF(mode || "questions"),
  pages: () => pbPageReport(),
  usableHeight: () => pbUsableHeightPx(),
  measure: (el) => pbMeasureBox(el),
  fileName: (mode) => pbFileName(mode || "questions"),
  state: () => ({
    count: pbState.items.length,
    mode: pbState.mode,
    busy: pbState.busy,
  }),
};
