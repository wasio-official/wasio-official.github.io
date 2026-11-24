/* ============================================================
   站点统计加载器（目前接百度统计；配置见 analytics-config.js）
   ------------------------------------------------------------
   设计原则：
     · 没配 ID 就**什么都不做** —— 不发请求、不写 cookie、不新增全局变量，
       所以默认上线是零成本的（不用等有了统计账号才能发版）。
     · 只统计正式域名（onlyHost），本地预览不污染数据。
     · 异步加载，失败不阻塞页面；统计挂了页面照常。
     · 只负责「统计」，页脚那个累计访客数仍由 visits.js（vercount）负责，
       两者互不影响：vercount 给总数，百度统计给按天的明细。
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.ANALYTICS_CONFIG || {};

  function trim(s) {
    return String(s == null ? "" : s).replace(/^\s+/, "").replace(/\s+$/, "");
  }

  var id = trim(cfg.baiduId);

  // 32 位十六进制才算合法；留空 / 写错（例如把 hm.js? 一起粘进来）都不加载
  if (!/^[0-9a-f]{32}$/i.test(id)) return;

  // file:// 本地打开不统计
  if (!/^https?:$/.test(location.protocol)) return;

  // 只在正式域名下统计（onlyHost 为空表示不限）
  var only = trim(cfg.onlyHost);
  if (only && location.hostname !== only) return;

  // 百度统计的标准接入方式：先建 _hmt 队列，再异步拉 hm.js。
  // 用队列而不是直接 import，是为了脚本加载失败时也不报错（_hmt 仍可入队）。
  window._hmt = window._hmt || [];
  try {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://hm.baidu.com/hm.js?" + id;
    var host = document.head || document.getElementsByTagName("head")[0] || document.documentElement;
    host.appendChild(s);
  } catch (e) {
    /* 加载失败就放弃统计，页面功能不受影响 */
  }
})();
