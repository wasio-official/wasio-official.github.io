/*
 * 页脚访客计数。
 *
 * 为什么不用「一行 script 标签」那种现成方案：
 *   官方脚本会在计数失败时把容器 display:none，但我们希望即使接口挂了
 *   也不要让页脚出现空洞/跳动；而且我们要控制它长什么样。所以这里自己调接口。
 *
 * 关键语义（已实测确认）：
 *   POST https://events.vercount.one/api/v2/log
 *   body: {url, isNewUv}
 *   - isNewUv: true  → 首次访问，site_uv +1
 *   - isNewUv: false → 同一浏览器再次访问（刷新），site_uv 不变
 *   返回: {status, data:{site_uv, site_pv, page_pv}}
 *
 * 所以「刷新页面」只会增加总访问量(site_pv)，不会增加访客数(site_uv)。
 * 页面展示的正是 site_uv，即刷新不涨的那个数字。
 *
 * 去重方式：写入一个一年有效期的 cookie（与本域名绑定），
 * 存在即视为「非首次」，因此同一浏览器只贡献 1 个访客。
 * 换浏览器 / 清 cookie / 无痕模式 会各算一个新访客——这是这类方案的固有口径。
 */
(function () {
  "use strict";

  var API = "https://events.vercount.one/api/v2/log";
  var COOKIE = "wasio_seen";
  var ONE_YEAR = 31536000; // 秒
  var TIMEOUT = 6000;

  // 只在 http(s) 下工作；本地 file:// 打开时直接跳过
  if (!/^https?:$/.test(location.protocol)) return;

  function hasCookie(name) {
    return document.cookie.split("; ").some(function (c) {
      return c.indexOf(name + "=") === 0;
    });
  }

  function setCookie(name) {
    document.cookie = name + "=1; path=/; max-age=" + ONE_YEAR + "; samesite=lax";
  }

  function render(el, n) {
    // 千分位，超过 1 万也保持可读
    el.textContent = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function report() {
    var el = document.getElementById("visit-uv");
    var wrap = document.getElementById("visit-count");
    if (!el || !wrap) return;

    var isNew = !hasCookie(COOKIE);
    if (isNew) setCookie(COOKIE);

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () { ctrl.abort(); }, TIMEOUT)
      : null;

    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: location.href, isNewUv: isNew }),
      signal: ctrl ? ctrl.signal : undefined,
      // 带上凭据，接口按来源域名归类
      mode: "cors",
      credentials: "omit"
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        var d = (res && res.data) || res || {};
        var uv = Number(d.site_uv);
        if (!isFinite(uv)) throw new Error("bad payload");
        render(el, uv);
        wrap.hidden = false;      // 拿到数字才显示，避免出现空白或 0
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        // 接口不可用（离线 / 被墙 / 服务故障）时，安静地不显示，
        // 页脚其余内容不受影响。
        wrap.hidden = true;
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  } else {
    report();
  }
})();
