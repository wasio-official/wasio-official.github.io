/* ============================================================
   出卷下载页：读取 pdfs/index.json，渲染免登录下载列表

   数据由 Actions 的「发布到站点」步骤维护（.github/scripts/publish_pdfs.py）：
   PDF 放在 pdfs/ 下，索引是 pdfs/index.json，只保留最近 30 组。

   容错要求（首次部署时 pdfs/ 可能还不存在）：
     - index.json 404 → 空状态，不报错、不白屏
     - 其它错误 → 友好提示 + 去组卷入口
   ============================================================ */

const PDFS_INDEX = "pdfs/index.json";
const PDFS_DIR = "pdfs/";

/** 字节数 → 人读大小（与 Actions 摘要里的写法一致） */
function pdfSize(n) {
  const num = Number(n);
  if (!num || num < 0) return "";
  if (num >= 1024 * 1024) return (num / 1024 / 1024).toFixed(2) + " MB";
  return Math.round(num / 1024) + " KB";
}

/** ISO 时间 → 本地化「2026/11/05 18:36」；解析不了就原样显示 */
function pdfTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 一个文件按钮：<a href="pdfs/<name>" download> */
function pdfFileBtn(f) {
  const kind = f.kind || "PDF";
  const meta = [f.pages ? f.pages + " 页" : "", pdfSize(f.size)]
    .filter(Boolean)
    .join(" · ");
  const primary = kind === "题卷" ? " pdf-btn-primary" : "";
  return `<a class="btn pdf-btn${primary}" href="${PDFS_DIR}${esc(f.name)}" download>
      <span>${esc(kind)}</span>${meta ? `<span class="pdf-btn-meta">${esc(meta)}</span>` : ""}
    </a>`;
}

/** 一组卷子 = 一张卡片（题卷 + 答案卷两个按钮） */
function pdfCard(item) {
  const files = (item.files || []).filter((f) => f && f.name);
  const runLink =
    typeof item.run === "string" && /^https?:/.test(item.run)
      ? `<a href="${esc(item.run)}" target="_blank" rel="noopener">运行记录</a>`
      : "";
  return `<article class="pdf-card">
      <div class="pdf-main">
        <div class="pdf-title-row">
          <span class="pdf-id">#${esc(item.id)}</span>
          <h3>${esc(item.title)}</h3>
        </div>
        <div class="pdf-meta">
          ${item.created ? `<span>生成于 ${esc(pdfTime(item.created))}</span>` : ""}
          ${runLink}
        </div>
      </div>
      <div class="pdf-actions">${files.map(pdfFileBtn).join("")}</div>
    </article>`;
}

function pdfEmptyHTML() {
  return `<div class="empty">
      <strong>还没有可下载的卷子</strong>
      <a href="library.html">去组卷 →</a>
      <div class="empty-tip">
        在题库里选好题、导出 JSON，到 GitHub 的 <code>papersets/inbox/</code> 上传（或手动触发 Actions），
        生成后回到本页刷新即可下载。
      </div>
    </div>`;
}

function pdfFailHTML(msg) {
  return `<div class="empty">
      <strong>下载列表暂时读不出来</strong>
      ${esc(msg || "可能是刚部署、还没生成索引，或网络抖了一下")}
      <div class="empty-tip">稍后刷新本页重试；<a href="library.html">先去组卷</a>。</div>
    </div>`;
}

async function pdfMain() {
  renderTopbar([{ label: "题库", href: "library.html" }, { label: "出卷下载" }]);

  const list = document.getElementById("pdf-list");
  const line = document.getElementById("result-line");

  try {
    const res = await fetch(PDFS_INDEX, { cache: "no-cache" });

    // 首要容错：还没发布过任何卷子时 index.json 就是 404，应该是空状态而不是报错
    if (res.status === 404) {
      list.innerHTML = pdfEmptyHTML();
      return;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const data = await res.json();
    const items = (Array.isArray(data && data.items) ? data.items : []).filter(
      (it) => it && (it.files || []).some((f) => f && f.name)
    );

    if (!items.length) {
      list.innerHTML = pdfEmptyHTML();
      return;
    }

    list.innerHTML = items.map(pdfCard).join("");
    if (line) line.textContent = `共 ${items.length} 组卷子（仅保留最近 30 组）`;
  } catch (err) {
    list.innerHTML = pdfFailHTML(err && err.message);
    console.error("出卷下载列表加载失败：", err);
  }
}

pdfMain();
