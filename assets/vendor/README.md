# assets/vendor —— 网页出卷用到的第三方库（自托管）

这两个文件只被 `pdfgen.html`（网页出卷）用到，**不走 CDN**：
`pdfbuild.js` 负责「html2canvas 逐页截图 → jsPDF 写 A4 → 直接下载 PDF」。
断网环境下也能用（页面里的图片同样是站内相对路径）。

| 文件 | 版本 | 上游（下载来源） | 大小 | SHA-256 |
|---|---|---|---|---|
| `jspdf.umd.min.js` | jsPDF **2.5.2** | `https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js`（npm 包 `jspdf`） | 365,730 B | `85BA2CC3FF858A20FA49FE6E457BEC863EA40B55A9F3725E58A940E62F6F61A4` |
| `html2canvas.min.js` | html2canvas **1.4.1** | `https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js`（npm 包 `html2canvas`） | 198,689 B | `E87E550794322E574A1FDA0C1549A3C70DAE5A93D9113417A429016838EAB8CB` |

许可证：jsPDF 为 MIT，html2canvas 为 MIT（文件头保留了各自的 `@license` / 版权注释）。
UMD 构建会把 `window.jspdf.jsPDF`、`window.html2canvas` 挂到全局，`pdfbuild.js` 用之前会检测。

## 更新方法

```powershell
# 本机需要走代理时先设：
$env:HTTPS_PROXY="http://127.0.0.1:9910"; $env:HTTP_PROXY="http://127.0.0.1:9910"

python - <<'PY'
import urllib.request
for name, url in [
    ("jspdf.umd.min.js", "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js"),
    ("html2canvas.min.js", "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"),
]:
    data = urllib.request.urlopen(url, timeout=40).read()
    open(f"assets/vendor/{name}", "wb").write(data)
    print(name, len(data))
PY
```

更新后请同步改：本文件的版本 / 哈希、`pdfbuild.js` 文件头注释、`pdfgen.html` 里引用处的版本说明。
新增文件前先用 `node --check <file>` 确认 UMD 构建完整（能通过语法检查、末尾挂全局）。
