/* ============================================================
   试卷投稿页（投稿入口 + 荣誉墙）
   ------------------------------------------------------------
   加载顺序（见 submit.html </body> 前）：
     assets/version.js          → window.SITE_VERSION（可选，只用来带版本段）
     assets/app.js              → 顶栏 / 页脚版本号
     assets/feedback-config.js  → window.FEEDBACK_CONFIG.submitFormUrl（必需）
     assets/submit.js           → 本文件

   注意：本页**不引入** feedback.js —— 纠错反馈只属于题库/题目相关页。
   二维码「第一次需要才加载」那套逻辑在这里独立实现一份（不能跨文件复用，
   因为那个文件压根不在本页加载）。

   行为：
     · 中途缺 submitFormUrl（空 / 非 http(s)）→ 显示「投稿通道暂未开放」，
       不生成任何链接、不请求二维码库。
     · 桌面（宽 ≥ 768px）：二维码 + 大按钮「打开投稿表单」+ 可复制链接。
     · 手机（宽 < 768px）：只给一个大按钮；不建二维码容器、不加载二维码库。
     · 二维码库 assets/vendor/qrcode.js（56KB）只在桌面端渲染时按需 <script> 拉；
       生成失败（库没加载上 / 内容太长 / 没 canvas）都有文字兜底。
     · 荣誉墙读 data/contributors.json；空 / 加载失败都退化成文字块，不白屏。

   参数拼装（金数据「扩展属性」x_field_1，一个字段承载全部上下文）：
     链接 = submitFormUrl ?(或&) x_field_1=encodeURIComponent("v版本｜试卷投稿")
     分隔符是全角「｜」（U+FF5C），编码后是 %EF%BD%9C：金数据扩展值对
     半角符号不友好。取不到 SITE_VERSION 时整段版本号省掉。

   荣誉墙数据（data/contributors.json）：
     {"contributors":[{"name":"张同学","count":3,"date":"2026-11-10","note":"2021-CPHOS 全套"}]}
     · name 必填，其余可缺省；count 非数字按 0 处理。
     · 排序：count 降序 → date 降序（YYYY-MM-DD 字符串比较即可）→ name 升序。
     · 只接受 http(s) 之外的字段一律 textContent 输出，不拼 HTML，天然防注入。
   ============================================================ */

(function () {
  "use strict";

  /* ---------------------------------------------- 常量 */

  var MOBILE_MAX = 768;          // 与 feedback.js / app.css 的手机断点一致
  var PARAM_DEFAULT = "x_field_1";
  var BAR = "\uFF5C";            // 全角竖线：金数据扩展属性的分隔符
  var QR_SRC = "assets/vendor/qrcode.js";
  var DATA_URL = "data/contributors.json";
  var VALUE_TAG = "试卷投稿";

  var cfg = window.FEEDBACK_CONFIG || {};
  var FORM_URL = trim(cfg.submitFormUrl);
  var PARAM = String(cfg.paramName || PARAM_DEFAULT);
  var urlOk = /^https?:\/\/\S+$/i.test(FORM_URL);

  var lastMobile = null;
  var resizeTimer = null;
  var boundResize = false;

  /* ---------------------------------------------- 小工具 */

  function trim(s) {
    return String(s == null ? "" : s).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
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

  /** 手机判定：拿不到宽度时按桌面处理（宁可多画一张二维码，也不要少了入口）。 */
  function isMobile() {
    var w = 0;
    try {
      w = window.innerWidth
        || (document.documentElement && document.documentElement.clientWidth)
        || 0;
    } catch (e) { w = 0; }
    return w > 0 && w < MOBILE_MAX;
  }

  /* ---------------------------------------------- 链接拼装 */

  /** 版本段：有 SITE_VERSION 才写成 "v2.1.0"，取不到就整段不带。 */
  function versionPart() {
    var v = trim(window.SITE_VERSION);
    return v ? "v" + v : "";
  }

  /** x_field_1 的值，例如 "v2.1.0｜试卷投稿"（版本取不到时就是 "试卷投稿"）。 */
  function submitValue() {
    var v = versionPart();
    return v ? v + BAR + VALUE_TAG : VALUE_TAG;
  }

  /** formUrl 可能自带 ? / #，保证参数落在正确位置、# 保持在最后。 */
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

  /* ---------------------------------------------- 二维码（仅桌面，按需加载） */

  var qrState = 0;      // 0 未加载 / 1 加载中 / 2 就绪 / 3 失败
  var qrQueue = [];

  function loadQr(cb) {
    if (window.qrcode) { cb(true); return; }
    if (qrState === 3) { cb(false); return; }

    qrQueue.push(cb);
    if (qrState === 1) return;
    qrState = 1;

    var s = document.createElement("script");
    s.src = QR_SRC;
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
    host.appendChild(node("p", "submit-fallback", msg));
    host.appendChild(node("p", "submit-fallback submit-fallback-url", url));
  }

  function drawCanvas(qr, n, cell, margin, size, label) {
    var canvas = document.createElement("canvas");
    if (!canvas || !canvas.getContext) return null;

    var ctx = null;
    try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
    if (!ctx) return null;

    var dpr = window.devicePixelRatio || 1;
    if (!ctx.scale) dpr = 1;                  // 老设备：不放大，逻辑尺寸直接画
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.className = "submit-qr-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
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

  /** 懒生成：只有桌面端渲染时才调用；手机端完全不走这里。 */
  function renderQr(host, url) {
    host.textContent = "正在生成二维码…";
    loadQr(function (ok) {
      if (!host.parentNode) return;           // 容器已被重渲染掉，画了也没人看
      if (!ok) {
        qrFallback(host, "二维码库加载失败，请复制下面的链接。", url);
        return;
      }
      try {
        var qr = window.qrcode(0, "M");       // 0 = 按内容自动选版本，M 级纠错
        qr.addData(url);
        qr.make();

        var n = qr.getModuleCount();
        // 目标约 200px；模块多时自动缩小格子，避免撑破面板
        var cell = Math.max(2, Math.min(6, Math.floor(200 / (n + 8))));
        var margin = cell * 4;                // 4 模块静区，扫码更稳
        var size = (n + 8) * cell;

        clear(host);
        var canvas = drawCanvas(qr, n, cell, margin, size, "投稿表单二维码");
        if (canvas) {
          host.appendChild(canvas);
        } else {
          // 老设备没有 canvas 2D：降级成 table（库自带，纯 DOM）
          host.innerHTML = qr.createTableTag(cell, margin);
        }
      } catch (e) {
        qrFallback(host, "二维码生成失败，请复制下面的链接。", url);
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

  /* ---------------------------------------------- 投稿入口：三种形态 */

  function renderClosed(host) {
    clear(host);
    var box = node("div", "submit-closed");
    box.appendChild(node("p", "submit-closed-title", "投稿通道暂未开放"));
    box.appendChild(node("p", "submit-hint",
      "表单地址还没配好。可以先去页脚的 B 站主页留言，或过几天再来看看。"));
    host.appendChild(box);
  }

  function openLink(url, cls, text) {
    var a = node("a", cls, text);
    a.setAttribute("href", url);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
    return a;
  }

  /** 手机：只有一个大按钮，不建二维码容器、不加载二维码库。 */
  function renderMobile(host, url) {
    host.appendChild(node("p", "submit-desc",
      "点下面的按钮打开投稿表单，第一题就是上传试卷文件。"));
    host.appendChild(openLink(url, "btn btn-primary submit-go", "打开投稿表单"));
    host.appendChild(node("p", "submit-hint",
      "将在新标签页打开金数据表单；返回本页可以继续浏览题库。"));
  }

  /** 桌面：二维码 + 大按钮 + 可复制链接。 */
  function renderDesktop(host, url) {
    var wrap = node("div", "submit-desktop");

    var qrCol = node("div", "submit-qrcol");
    var qrBox = node("div", "submit-qr");
    qrBox.id = "submit-qr";
    qrCol.appendChild(qrBox);
    qrCol.appendChild(node("p", "submit-hint", "手机扫码打开投稿表单"));
    wrap.appendChild(qrCol);

    var side = node("div", "submit-side");
    side.appendChild(node("p", "submit-desc",
      "上传试卷文件用手机更方便（相册里的拍照/扫描件直接选）；电脑上也可以点按钮直接填表。"));

    side.appendChild(openLink(url, "btn btn-primary submit-open", "打开投稿表单"));

    var row = node("div", "submit-linkrow");
    var input = node("input", "submit-link");
    input.type = "text";
    input.readOnly = true;
    // 显示用解码后的形式：`%EF%BD%9C` 这类百分号串人看不懂，中文原样更好读；
    // 复制/打开时浏览器会自动重新编码，功能不受影响。
    var shown = url;
    try { shown = decodeURIComponent(url); } catch (e) { shown = url; }
    input.value = shown;
    input.setAttribute("aria-label", "投稿表单链接");
    input.setAttribute("spellcheck", "false");
    var copy = node("button", "btn submit-copy", "复制链接");
    copy.type = "button";
    copy.setAttribute("aria-label", "复制投稿表单链接");
    copy.addEventListener("click", function () { copyUrl(url, input, copy); }, false);
    row.appendChild(input);
    row.appendChild(copy);
    side.appendChild(row);

    side.appendChild(node("p", "submit-hint",
      "链接里带了站点版本号，方便我们对应是哪一版页面进来的。"));

    wrap.appendChild(side);
    host.appendChild(wrap);

    renderQr(qrBox, url);
  }

  function renderChannel() {
    var host = document.getElementById("submit-channel");
    if (!host) return;

    clear(host);
    if (!urlOk) { renderClosed(host); return; }     // 未配置：只给一句「暂未开放」

    var url = buildUrl(submitValue());
    if (isMobile()) renderMobile(host, url);
    else renderDesktop(host, url);
  }

  /* ---------------------------------------------- 荣誉墙 */

  function pickList(data) {
    if (isArray(data)) return data;
    if (data && isArray(data.contributors)) return data.contributors;
    return [];
  }

  function normalize(c) {
    if (!c || typeof c !== "object") return null;
    var name = trim(c.name);
    if (!name) return null;
    var n = Number(c.count);
    if (!isFinite(n) || n < 0) n = 0;
    return {
      name: name,
      count: Math.floor(n),
      date: trim(c.date),
      note: trim(c.note)
    };
  }

  function sortContributors(list) {
    list.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;  // date 降序
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return list;
  }

  function contribCard(c, index) {
    var card = node("article", "contrib-card");

    var top = node("div", "contrib-top");
    var rank = node("div", "contrib-rank" + (index < 3 ? " is-top" : ""), String(index + 1));
    rank.setAttribute("aria-hidden", "true");
    top.appendChild(rank);
    top.appendChild(node("div", "contrib-name", c.name));
    card.appendChild(top);

    var cnt = node("div", "contrib-count");
    cnt.appendChild(node("span", null, "投稿 "));
    cnt.appendChild(node("b", null, String(c.count)));
    cnt.appendChild(node("span", null, " 份"));
    card.appendChild(cnt);

    if (c.note) card.appendChild(node("p", "contrib-note", c.note));
    if (c.date) {
      var d = node("div", "contrib-date", c.date);
      d.title = "入库日期";
      card.appendChild(d);
    }

    card.setAttribute("aria-label",
      c.name + "，投稿 " + c.count + " 份" + (c.note ? "，" + c.note : ""));
    return card;
  }

  function countLine(n) {
    return n > 0 ? "共 " + n + " 位投稿者" : "";
  }

  function renderContributors(host, list) {
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var item = normalize(list[i]);
      if (item) items.push(item);
    }
    sortContributors(items);

    var badge = document.getElementById("contrib-count");
    if (badge) badge.textContent = countLine(items.length);

    clear(host);
    if (!items.length) { renderEmpty(host); return; }

    host.className = "contrib-grid";
    for (var k = 0; k < items.length; k++) host.appendChild(contribCard(items[k], k));
  }

  /** 空状态：不是「加载失败」，是「等你来当第一个」。 */
  function renderEmpty(host) {
    host.className = "";
    clear(host);
    var box = node("div", "empty contrib-empty");
    box.appendChild(node("strong", null, "还没有人上榜"));
    box.appendChild(node("p", "contrib-empty-line", "第一份投稿就是第一行名字。"));
    box.appendChild(node("p", "empty-tip",
      "试卷通过审校后，你的名字会连同投稿份数出现在这里。"));
    host.appendChild(box);
  }

  /** 加载失败：同样有内容、有下一步，不白屏。 */
  function renderError(host, reason) {
    host.className = "";
    clear(host);
    var box = node("div", "empty contrib-empty contrib-error");
    box.appendChild(node("strong", null, "荣誉墙暂时读不出来"));
    box.appendChild(node("p", "contrib-empty-line", "上面的投稿入口不受影响，仍然可以正常投稿。"));
    box.appendChild(node("p", "empty-tip", "稍后刷新本页再试。"));
    if (reason) {
      var detail = node("p", "contrib-detail", reason);
      box.appendChild(detail);
    }
    host.appendChild(box);
  }

  function loadContributors() {
    var host = document.getElementById("contrib-list");
    if (!host) return;

    // 老浏览器没有 fetch / Promise：直接给失败态，不去猜
    if (typeof window.fetch !== "function" || typeof window.Promise !== "function") {
      renderError(host, "");
      return;
    }

    try {
      window.fetch(DATA_URL, { cache: "no-cache" })
        .then(function (res) {
          if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "?"));
          return res.json();
        })
        .then(function (data) {
          renderContributors(host, pickList(data));
        }, function (err) {
          var msg = err && err.message ? String(err.message) : "";
          renderError(host, msg);
        });
    } catch (e) {
      renderError(host, e && e.message ? String(e.message) : "");
    }
  }

  /* ---------------------------------------------- 启动 */

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      var m = isMobile();
      if (m === lastMobile) return;
      lastMobile = m;
      renderChannel();               // 跨过断点才重画：桌面→手机连库都不再请求
    }, 150);
  }

  function boot() {
    try { renderTopbar([{ label: "投稿" }]); } catch (e) { /* app.js 没加载成功时顶栏空着 */ }

    lastMobile = isMobile();
    renderChannel();
    loadContributors();

    if (!boundResize && window.addEventListener) {
      boundResize = true;
      window.addEventListener("resize", onResize, false);
    }
  }

  if (document.body) {
    boot();
  } else if (document.addEventListener) {
    document.addEventListener("DOMContentLoaded", boot, false);
  }
})();
