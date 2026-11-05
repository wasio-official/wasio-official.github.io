# papersets/inbox —— 线上出卷投递箱

把网站上导出的选题目录 JSON（`组卷-xxx.json`）放到这个目录，**push / 上传到仓库**
就会自动触发 GitHub Actions 出卷，不需要本机装 TeX Live（手机也能用）。

- 工作流：[exam-pdf.yml](../../.github/workflows/exam-pdf.yml)
- 直链：<https://github.com/wasio-official/wasio-official.github.io/actions/workflows/exam-pdf.yml>

## 怎么用（手机或电脑）

1. 在网站上选好题 → **导选出卷目录**（得到 `组卷-xxx.json`）；
2. 打开仓库页面 → `papersets/inbox/` → **Add file → Upload files**，把 JSON 传进来，
   提交（Commit changes）；
3. 到 **Actions** 页面等这次运行跑完（**约 3–5 分钟**，含装 TeX）；
4. 在该次运行底部的 **Artifacts** 下载 `exam-pdf-<run号>.zip`，
   解压即是 `<标题>·题卷.pdf` 与 `<标题>·答案卷.pdf`。

也可以不走上传文件：Actions 页面 → **Run workflow** → 把 JSON 粘贴进
`paperset_json` 输入框（留空则处理本目录下的所有 `*.json`），`mode` 选
`both` / `questions` / `answers`。

## 规则

- **一个 JSON = 一份卷子**，按文件名排序依次处理，各自输出到 `out/<序号>-<文件名>/`；
- push 触发时 `mode` 固定为 `both`（题卷 + 答案卷）；只想出一份就用 Run workflow 选 `mode`；
- 文件名只用英文/数字/中文都行，但**不要重名**（同名的会被序号区分，不好认）；
- 只用仓库里的题库快照出卷（`--offline`），不联网取题；题库更新后才会有新题；
- 出卷结果不写回仓库，只作为 artifact 提供，**保留 90 天**；
- artifact 名 `exam-pdf-<run号>`；失败时会额外上传 `exam-pdf-logs-<run号>`
  （`.log` / `.tex`，用于排查缺字、字体、排版报错）。

## 注意

- 提交到这个目录就等于**公开**了这份选题（仓库是 public 的）；
- 文件会留在 git 历史里，出完卷建议删掉（再 push 一次不会重复出卷，只有
  `*.json` 的新增/修改才触发；删除不会触发）；
- 本目录已放了一个 `示例-3题.json`，它会**故意触发一次运行**，用来验证链路是否通；
  确认无误后可以删掉。

## 环境说明

GitHub Actions 的 Ubuntu 环境里**没有** Windows 的 MS Mincho，工具会自动改用
Noto CJK（`fonts-noto-cjk`）；圈号 `①②③`、罗马数字 `Ⅰ Ⅱ`、`℃`、下标 `₁₂`
等仍能正常显示。若日志出现 `Missing character` 警告，说明该字符两种字体都没有，
不影响出卷。
