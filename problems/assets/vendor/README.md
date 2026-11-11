# assets/vendor —— 站点用到的第三方库（自托管）

下面的 jsPDF / html2canvas 这两个文件只被 `pdfgen.html`（网页出卷）用到，**不走 CDN**：
`pdfbuild.js` 负责「html2canvas 逐页截图 → jsPDF 写 A4 → 直接下载 PDF」。
断网环境下也能用（页面里的图片同样是站内相对路径）。
文末的 `qrcode.js` 只给纠错反馈面板用，与出卷无关。

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

## qrcode.js —— 纠错反馈面板的二维码（自托管）

| 文件 | 版本 | 上游（下载来源） | 大小 | SHA-256 |
|---|---|---|---|---|
| `qrcode.js` | qrcode-generator **1.4.4**（Kazuhiko Arase） | `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js`（npm 包 `qrcode-generator`；备用 `https://unpkg.com/qrcode-generator@1.4.4/qrcode.js`） | 56,694 B | `18AE399F81182BC9DE916E9C77B195DF20CC58D6F2D55A62B085A299F1BF1780` |

- 许可证：MIT（文件头保留了原作者版权与许可注释）。纯 JS、无依赖、运行时**不发任何网络请求**，也不从 CDN 取任何东西。
- 全局入口：文件末尾的 `var qrcode = function(){…}()`，浏览器里即 `window.qrcode`（AMD / CommonJS 环境另走 UMD 分支）。
- 只被 `assets/feedback.js` 使用，且**按需加载**：只有桌面端（宽 ≥ 768px）第一次打开反馈面板时才会插入
  `<script src="assets/vendor/qrcode.js">`；`formUrl` 未配置或手机端永远不会请求这个文件。
- 用法：`qrcode(0, "M")`（0 = 自动选版本，M 级纠错）→ `addData(url)` → `make()` →
  `getModuleCount()` / `isDark(r,c)` 自己画 canvas；没有 canvas 2D 时降级为库自带的
  `createTableTag(cellSize, margin)`。二维码内容只是 `encodeURIComponent` 后的 ASCII 链接，
  不依赖库的 UTF-8 字节转换（默认 `stringToBytes` 只处理单字节字符）。
- 校验：`node --check assets/vendor/qrcode.js` 通过。

### 更新方法

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:9910"; $env:HTTP_PROXY="http://127.0.0.1:9910"
python -c "import urllib.request; d=urllib.request.urlopen('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js', timeout=60).read(); open('assets/vendor/qrcode.js','wb').write(d); print(len(d))"
```

更新后同步改：本文件的版本 / 大小 / 哈希，以及 `feedback.js` 文件头注释里的库说明。
