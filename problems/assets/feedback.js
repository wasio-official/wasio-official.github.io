/* ============================================================
   纠错反馈入口（金数据问卷）
   ------------------------------------------------------------
   加载顺序（见各页面 </body> 前）：
     assets/version.js          → window.SITE_VERSION（可选，只用来带版本段）
     assets/feedback-config.js  → window.FEEDBACK_CONFIG（必需）
     assets/feedback.js         → 本文件

   行为：
     · formUrl 为空 → 本文件立即 return：不建按钮、不加载二维码库、零请求。
     · 只在这四个页面出现：library / tags / paper / question。
       index.html（标题页）以及其它页面即使误引入也不会显示。
     · 桌面（宽 ≥ 768px）：右下角圆形按钮 → 弹窗：二维码 + 可复制链接 + 打开链接。
     · 手机（宽 < 768px）：同一个按钮 → 底部面板：一个直达问卷的大按钮，不画二维码。
     · 二维码库 vendor/qrcode.js 只在桌面端第一次打开面板时按需加载；
       未配置或手机端永远不会请求它。

   参数拼装（金数据「扩展属性」x_field_1，一个字段承载全部上下文）：
     链接 = formUrl ?(或&) x_field_1=encodeURIComponent("v版本｜卷名｜第N题")
     分隔符是全角「｜」（U+FF5C）：金数据扩展值对半角符号不友好。
   ============================================================ */

(function () {
  "use strict";

  /* ---------------------------------------------- 配置与前置检查 */

  var cfg = window.FEEDBACK_CONFIG;
  if (!cfg || typeof cfg.formUrl !== "string") return;

  var FORM_URL = trim(cfg.formUrl);
  if (!FORM_URL) return;                              // 未配置：下面一行都不执行
  if (!/^https?:\/\/\S+$/i.test(FORM_URL)) return;    // 只接受 http(s)，挡掉 javascript: 之类

  var PARAM = String(cfg.paramName || "x_field_1");
  var ID_MODE = String(cfg.idMode || "name").toLowerCase();

  /* 只有这四页显示入口；index.html 明确不放。 */
  var PAGES = {
    "question.html": { key: "question", label: "单题页" },
    "paper.html": { key: "paper", label: "试卷页" },
    "tags.html": { key: "tags", label: "考点页" },
    "library.html": { key: "library", label: "题库页" }
  };

  var fab = null;
  var overlay = null;
  var panel = null;
  var bodyBox = null;
  var closeBtn = null;
  var isOpen = false;

  /* ---------------------------------------------- 小工具 */

  function trim(s) {
    return String(s == null ? "" : s).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  /** 拼进参数里的文本：去换行/首尾空白，并把全角分隔符换掉，避免破坏字段结构。 */
  function clean(s) {
    return trim(s)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\uFF5C/g, "\uFF0F");
  }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(n) {
    while (n.firstChild) n.removeChild(n.firstChild);
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  /* ---------------------------------------------- 页面与上下文 */

  function currentPage() {
    var path = "";
    try { path = String(window.location.pathname || ""); } catch (e) { path = ""; }
    var file = path.split("/").pop().toLowerCase();
    if (!file) return null;
    return PAGES[file] || null;
  }

  /**
   * 页面上已有的全局 state（各页面脚本用 const 声明，不在 window 上）。
   * 用 typeof 做存在性判断；脚本还没执行完时可能处在 TDZ，所以 try/catch。
   */
  function pageState() {
    try {
      if (typeof state !== "undefined" && state) return state;
    } catch (e) { /* 页面脚本尚未初始化 */ }
    return null;
  }

  function siteVersion() {
    var v = window.SITE_VERSION;
    if (v === undefined || v === null || trim(v) === "") return "";
    return "v" + trim(v);
  }

  /** 卷名 / slug：idMode 说了算；取不到时两种字段互为兜底。 */
  function paperLabel(paper) {
    if (!paper) return "";
    var v = ID_MODE === "slug" ? paper.slug : paper.name;
    if (trim(v) === "") v = paper.name || paper.slug || "";
    return clean(v);
  }

  /** 返回除版本号之外的上下文段（1～2 段）；拿不到就退化为页面名。 */
  function contextParts(page) {
    var st = pageState();

    if (page.key === "question") {
      var qPaper = st && st.paper;
      var label = paperLabel(qPaper);
      if (label) {
        var idx = st && typeof st.index === "number" ? st.index : 0;
        return [label, "第" + (idx + 1) + "题"];
      }
      return [page.label];
    }

    if (page.key === "paper") {
      var pPaper = st && st.paper;
      var plabel = paperLabel(pPaper);
      if (plabel) return [plabel, "整卷"];
      return [page.label];
    }

    if (page.key === "tags") {
      if (st && isArray(st.path)) {
        var segs = [];
        for (var i = 0; i < st.path.length; i++) {
          var seg = clean(st.path[i]);
          if (seg) segs.push(seg);
        }
        return ["考点", segs.length ? segs.join("/") : "全部"];
      }
      return [page.label];
    }

    if (page.key === "library") {
      if (st && typeof st === "object") {
        var bits = [];
        var kw = clean(st.q || "");
        var cat = clean(st.category || "");
        if (kw) bits.push("搜索「" + kw + "」");
        if (cat) bits.push("类型「" + cat + "」");
        return ["题库", bits.length ? bits.join("、") : "全部"];
      }
      return [page.label];
    }

    return [page.label];
  }

  /** 完整的 x_field_1 值，例如 "v2.0.3｜IPhO-第31届｜第1题"。 */
  function feedbackValue(page) {
    var parts = [];
    var ver = siteVersion();
    if (ver) parts.push(ver);                 // 取不到版本号就不带版本段
    var rest = contextParts(page);
    for (var i = 0; i < rest.length; i++) {
      if (rest[i]) parts.push(rest[i]);
    }
    return parts.join("\uFF5C");
  }

  /** formUrl 可能自带 ? / #，这里保证参数落在正确位置。 */
  function buildUrl(value) {
    var base = FORM_URL;
    var hash = "";
    var hi = base.indexOf("#");
    if (hi >= 0) {
      hash = base.slice(hi);
      base = base.slice(0, hi);
    }
    var sep = base.indexOf("?") >= 0 ? "&" : "?";
    if (/[?&]$/.test(base)) sep = "";
    return base + sep + PARAM + "=" + encodeURIComponent(value) + hash;
  }

  /* ---------------------------------------------- 样式开关 */

  function rootClass(add) {
    var root = document.documentElement;
    if (!root || !root.classList) return;
    if (add) root.classList.add("fb-open");
    else root.classList.remove("fb-open");
  }

  function showNode(n, show) {
    if (show) n.removeAttribute("hidden");
    else n.setAttribute("hidden", "hidden");
  }

  /* ---------------------------------------------- 二维码（桌面端） */

  var qrState = 0;      // 0 未加载 / 1 加载中 / 2 就绪 / 3 失败
  var qrQueue = [];

  function loadQr(cb) {
    if (window.qrcode) { cb(true); return; }
    if (qrState === 3) { cb(false); return; }

    qrQueue.push(cb);
    if (qrState === 1) return;
    qrState = 1;

    var s = document.createElement("script");
    s.src = "assets/vendor/qrcode.js";
    s.async = true;
    s.onload = function () { qrReady(!!window.qrcode); };
    s.onerror = function () { qrReady(false); };
    var host = document.head || document.getElementsByTagName("head")[0] || document.body;
    host.appendChild(s);
  }

  function qrReady(ok) {
    qrState = ok ? 2 : 3;
    var queue = qrQueue;
    qrQueue = [];
    for (var i = 0; i < queue.length; i++) {
      try { queue[i](ok); } catch (e) { /* 单个回调失败不影响其它 */ }
    }
  }

  function qrFallback(host, msg, url) {
    clear(host);
    host.appendChild(node("p", "fb-fallback", msg));
    host.appendChild(node("p", "fb-fallback fb-fallback-url", url));
  }

  function drawCanvas(qr, n, cell, margin, size) {
    var canvas = document.createElement("canvas");
    if (!canvas || !canvas.getContext) return null;

    var ctx = null;
    try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
    if (!ctx) return null;

    var dpr = window.devicePixelRatio || 1;
    if (!ctx.scale) dpr = 1;                  // 老设备：不放大，逻辑尺寸直接画
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.className = "fb-qr-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "反馈问卷二维码");
    if (canvas.style) {
      canvas.style.width = size + "px";
      canvas.style.height = size + "px";
    }
    if (dpr !== 1) ctx.scale(dpr, dpr);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
        }
      }
    }
    return canvas;
  }

  /**
   * 懒生成：只有桌面端打开面板时才调用；手机端完全不走这里。
   * 生成失败（库没加载上、内容太长、canvas 不可用）都有文字兜底。
   */
  function renderQr(host, url) {
    host.textContent = "正在生成二维码…";
    loadQr(function (ok) {
      if (!host.parentNode) return;           // 面板已关掉，画了也没人看
      if (!ok) {
        qrFallback(host, "二维码库加载失败，请复制下方链接。", url);
        return;
      }
      try {
        var qr = window.qrcode(0, "M");       // 0 = 按内容自动选版本，M 级纠错
        qr.addData(url);
        qr.make();

        var n = qr.getModuleCount();
        // 目标约 220px；模块多时自动缩小格子，避免撑破面板
        var cell = Math.max(2, Math.min(6, Math.floor(220 / (n + 8))));
        var margin = cell * 4;                // 4 模块静区，扫码更稳
        var size = (n + 8) * cell;

        clear(host);
        var canvas = drawCanvas(qr, n, cell, margin, size);
        if (canvas) {
          host.appendChild(canvas);
        } else {
          // 老设备没有 canvas 2D：降级成 table（库自带，纯 DOM）
          host.innerHTML = qr.createTableTag(cell, margin);
        }
      } catch (e) {
        qrFallback(host, "二维码生成失败，请复制下方链接。", url);
      }
    });
  }

  /* ---------------------------------------------- 复制链接 */

  function copyUrl(url, input, btn) {
    var timer = null;

    function restore() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        btn.textContent = "复制链接";
        timer = null;
      }, 1600);
    }

    function finish(ok) {
      btn.textContent = ok ? "已复制" : "请手动复制";
      restore();
    }

    function execCopy() {
      var ok = false;
      try {
        input.focus();
        input.select();
        ok = document.execCommand ? document.execCommand("copy") : false;
      } catch (e) {
        ok = false;
      }
      finish(!!ok);
    }

    try {
      var nav = window.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(url).then(function () { finish(true); }, execCopy);
        return;
      }
    } catch (e) { /* 落到 execCommand */ }
    execCopy();
  }

  /* ---------------------------------------------- 面板内容 */

  function isMobile() {
    var w = 0;
    try {
      w = window.innerWidth
        || (document.documentElement && document.documentElement.clientWidth)
        || 0;
    } catch (e) { w = 0; }
    return w > 0 && w < 768;
  }

  function renderBody(url) {
    clear(bodyBox);

    var mobile = isMobile();

    bodyBox.appendChild(node("p", "fb-desc", mobile
      ? "发现题目、答案或考点标注有误？点下面的按钮填写反馈。"
      : "发现题目、答案或考点标注有误？手机扫码，或复制链接在浏览器中打开。"));

    if (mobile) {
      var go = node("a", "btn btn-primary fb-go", "打开反馈问卷");
      go.setAttribute("href", url);
      go.setAttribute("target", "_blank");
      go.setAttribute("rel", "noopener");
      bodyBox.appendChild(go);
      bodyBox.appendChild(node("p", "fb-hint", "将在新标签页打开金数据问卷，返回本页可继续浏览。"));
      return;
    }

    var qrBox = node("div", "fb-qr");
    qrBox.id = "fb-qr";
    bodyBox.appendChild(qrBox);
    bodyBox.appendChild(node("p", "fb-hint", "手机扫码打开问卷"));

    var row = node("div", "fb-linkrow");
    var input = node("input", "fb-link");
    input.type = "text";
    input.readOnly = true;
    // 显示用解码后的形式：`%EF%BD%9C` 这类百分号串人看不懂，中文原样更好读；
    // 复制/打开时浏览器会自动重新编码，功能不受影响。
    var shown = url;
    try { shown = decodeURIComponent(url); } catch (e) { shown = url; }
    input.value = shown;
    input.setAttribute("aria-label", "反馈问卷链接");
    var copy = node("button", "btn fb-copy", "复制链接");
    copy.type = "button";
    copy.addEventListener("click", function () { copyUrl(url, input, copy); }, false);
    row.appendChild(input);
    row.appendChild(copy);
    bodyBox.appendChild(row);

    var actions = node("p", "fb-actions");
    var openLink = node("a", "btn btn-primary fb-open", "在浏览器打开");
    openLink.setAttribute("href", url);
    openLink.setAttribute("target", "_blank");
    openLink.setAttribute("rel", "noopener");
    actions.appendChild(openLink);
    bodyBox.appendChild(actions);

    renderQr(qrBox, url);
  }

  /* ---------------------------------------------- 打开 / 关闭 */

  function onKeydown(e) {
    if (!e) return;
    if (e.key === "Escape" || e.keyCode === 27 || e.which === 27) closePanel();
  }

  function openPanel() {
    if (isOpen) return;
    var page = currentPage();
    if (!page) return;

    isOpen = true;
    renderBody(buildUrl(feedbackValue(page)));
    showNode(overlay, true);
    rootClass(true);
    document.addEventListener("keydown", onKeydown, false);
    try { closeBtn.focus(); } catch (e) { /* 某些老浏览器不支持 focus */ }
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    showNode(overlay, false);
    rootClass(false);
    document.removeEventListener("keydown", onKeydown, false);
    try { fab.focus(); } catch (e) { /* 同上 */ }
  }

  /* ---------------------------------------------- 构建 UI */

  function buildUi() {
    if (fab) return;                          // 只建一次

    fab = node("button", "fb-fab", "反馈");
    fab.id = "fb-fab";
    fab.type = "button";
    fab.title = "纠错反馈";
    fab.setAttribute("aria-label", "纠错反馈：报告题目错误或提出建议");
    fab.addEventListener("click", openPanel, false);

    overlay = node("div", "fb-overlay");
    overlay.id = "fb-overlay";
    showNode(overlay, false);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePanel();   // 点遮罩关闭
    }, false);

    panel = node("div", "fb-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "fb-title");
    panel.tabIndex = -1;

    var head = node("div", "fb-head");
    var title = node("h2", "fb-title", "纠错反馈");
    title.id = "fb-title";
    closeBtn = node("button", "fb-close", "\u00D7");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭反馈面板");
    closeBtn.addEventListener("click", closePanel, false);

    head.appendChild(title);
    head.appendChild(closeBtn);

    bodyBox = node("div", "fb-body");
    panel.appendChild(head);
    panel.appendChild(bodyBox);
    overlay.appendChild(panel);

    document.body.appendChild(fab);
    document.body.appendChild(overlay);
    if (document.body.classList) document.body.classList.add("fb-has-fab");
  }

  /* ---------------------------------------------- 启动 */

  function boot() {
    if (!currentPage()) return;               // 标题页 / 其它页：什么都不做
    buildUi();
  }

  if (document.body) {
    boot();
  } else if (document.addEventListener) {
    document.addEventListener("DOMContentLoaded", boot, false);
  }
})();
