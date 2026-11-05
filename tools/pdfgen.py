"""出卷工具：读 paperset.json → 取题目 → 生成 LaTeX → 编译成 PDF。

用法：
    python pdfgen.py paperset.json                    # 题卷 + 答案卷
    python pdfgen.py paperset.json -o 我的卷子        # 指定输出目录
    python pdfgen.py paperset.json --mode questions   # 只出题卷
    python pdfgen.py paperset.json --mode answers     # 只出答案卷
    python pdfgen.py paperset.json --tex-only         # 只出 .tex，不编译
    python pdfgen.py paperset.json --offline          # 只用本地数据，不联网
    python pdfgen.py --check                          # 自检环境（TeX / 字体 / 数据）

输出（同一 outdir）：
    <标题>·题卷.pdf / <标题>·题卷.tex / <标题>·题卷.md
    <标题>·答案卷.pdf / <标题>·答案卷.tex / <标题>·答案卷.md

设计要点：
  - **题卷与答案卷是两份独立文档**：题卷只排题干；答案卷是「题干+解析+答案」
    的完整版，便于对照。meta.show_analysis 只决定默认是否出答案卷，
    显式 --mode 优先。
  - **数据优先本地、回退网络**：本机有 data/ 就直接读，没有就去线上拉。
  - **图片必须落盘并改写路径**：站点里是 data/images/<slug>/<中文名>.jpg，
    LaTeX 需要 images/<中文名>.jpg。md2latex.py 会处理中文路径，
    但不会帮你复制文件 —— 这一步在本脚本里做。
  - **字体回退是必需的**：全库约 15% 的题含 ①②③ / Ⅰ Ⅱ / ℃ / ₁₂ 这类字符，
    SimSun 没有，不处理就会在 PDF 里变成空白。
  - **版式走 examtex.py**：不再用 md2latex 的整篇模板，只借用它的转义 / 公式 /
    表格能力；试卷导言区、卷头、题号、分页、图片宽度都在 examtex 里控制。

零第三方依赖（Pillow 可选，仅用于读图片像素尺寸）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径

HERE = Path(__file__).resolve().parent


def _locate_repo() -> Path:
    """定位站点仓库（题库 data/ 的父目录），两套布局都要能用。

    1) 入仓布局   <repo>/tools/pdfgen.py  → 上一级就是仓库根，题库在 <repo>/data；
    2) 仓库外布局 Github page/pdfgen.py   → 同级目录 wasio-official.github.io/data。

    先看「本文件的上一级是否就是带 data/ 的仓库根」，是就用它（GitHub Actions
    只能看到仓库内的文件，必须走这条）；否则回落到原来的同级目录。
    """
    parent = HERE.parent
    if (parent / "data" / "papers").is_dir():
        return parent
    return HERE / "wasio-official.github.io"


def _locate_md2latex() -> Path:
    """md2latex.py 定位：入仓版一起放进了 tools/；仓库外布局仍用 MinerU 那份。"""
    local = HERE / "md2latex.py"
    if local.is_file():
        return local
    return Path(r"D:\Wasio\Workspace\MinerU\md2latex.py")


# 站点仓库（本地有就用本地的，没有就联网）
REPO = _locate_repo()
MD2LATEX = _locate_md2latex()
SITE = "https://wasio-official.github.io"
# TeX Live 2026（若 PATH 里没有，自动补上，省得每次手动设）
TEXBIN = Path(r"C:\texlive\2026\bin\windows")

IMG_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp")

# 符号回退字体候选（按优先级）。SimSun 缺圈号/罗马数字/上下标，
# 需要一个覆盖这些字符的字体兜底：
#   Windows 上 MS Mincho 覆盖最全（实测 31/31）→ 首选；
#   Linux / GitHub Actions 上没有 MS Mincho，用 Noto CJK（apt fonts-noto-cjk）顶上。
# 实际用哪个由 pick_fallback_font() 探测系统已装字体后决定，**不写死第一个**。
FALLBACK_FONTS = [
    "MS Mincho",           # Windows（覆盖最全）
    "Noto Serif CJK SC",   # Linux / Actions：apt 装 fonts-noto-cjk
    "Noto Sans CJK SC",
    "Source Han Serif SC",
    "MS Gothic",           # Windows 备选
    "Meiryo",
    "DejaVu Sans",         # 兜底：数学符号 / 上下标
]

# 需要回退的字符：圈号、带圈数字、罗马数字、常见符号、上下标
FALLBACK_CHARS = (
    "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
    "㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟"
    "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ"
    "℃℉△▲▽▼→←↑↓↔⇒⇔−±×÷≈≠≤≥∞∠⊥∥⊙∫∮∑∏√∛"
    "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"
    "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾"
    "─│┌┐└┘├┤┬┴┼"
)


def log(msg: str = "") -> None:
    print(msg, flush=True)


def _force_utf8() -> None:
    """Windows 控制台默认 GBK，直接 print ✓/✗/圈号会 UnicodeEncodeError。
    这里把标准输出强制成 UTF-8（双击 .bat 运行时尤其重要）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def die(msg: str) -> "None":
    log(f"✗ {msg}")
    sys.exit(1)


def ensure_tex_on_path() -> None:
    """TeX Live 不在 PATH 时自动补上（本机固定安装位置）。"""
    if TEXBIN.is_dir():
        path = os.environ.get("PATH", "")
        if str(TEXBIN) not in path:
            os.environ["PATH"] = str(TEXBIN) + os.pathsep + path


# ---------------------------------------------------------------------------
# 数据获取

class Store:
    """题目的取用入口：优先本地仓库，缺失则联网。"""

    def __init__(self, offline: bool = False):
        self.offline = offline
        self.local = REPO / "data" if (REPO / "data").is_dir() else None
        self._cache: dict[str, dict] = {}
        self.net_hits = 0
        self.local_hits = 0

    def paper(self, slug: str) -> dict:
        if slug in self._cache:
            return self._cache[slug]

        p = self.local / "papers" / f"{slug}.json" if self.local else None
        if p and p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            self.local_hits += 1
        elif self.offline:
            raise RuntimeError(f"本地没有 {slug}，且已指定 --offline")
        else:
            url = f"{SITE}/data/papers/{slug}.json"
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            self.net_hits += 1

        self._cache[slug] = data
        return data

    def question(self, slug: str, qid: str) -> dict:
        paper = self.paper(slug)
        for q in paper.get("questions", []):
            if str(q.get("id")) == str(qid):
                return q
        raise RuntimeError(f"{slug} 里没有第 {qid} 题")

    def image(self, rel: str) -> tuple[bytes | None, str]:
        """按站点里的相对路径取图，返回 (字节, 文件名)。"""
        rel = rel.strip()
        name = rel.split("/")[-1]

        if self.local:
            p = self.local.parent / rel
            if p.is_file():
                return p.read_bytes(), p.name
            # 扩展名可能被省略，试探一下
            for ext in IMG_EXT:
                q = self.local.parent / (rel + ext)
                if q.is_file():
                    return q.read_bytes(), q.name
        if self.offline:
            return None, name
        try:
            # ⚠️ 图片路径里有中文，必须 percent-encode，
            # 否则 urllib 会拼出非法 URL 而 404（实测踩过）。
            from urllib.parse import quote
            url = f"{SITE}/" + quote(rel, safe="/")
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read(), name
        except Exception:
            return None, name


# ---------------------------------------------------------------------------
# Markdown 拼装

def strip_sep(text: str) -> str:
    """清理 md2latex 不认、会在 PDF 里原样露出的 Markdown 痕迹。

    实测三类会露馅：
      1. 分隔线 `---`        —— md2latex 不做处理，会变成一行破折号
      2. 行内加粗 `**x**`     —— 同上，星号原样显示
      3. HTML 注释/空标签     —— 偶尔出现在源数据里
    题面里的数学公式用的是 $...$，不受影响。
    """
    t = text or ""
    # 分隔线整行删掉
    t = re.sub(r"^\s*[-*_]{3,}\s*$", "", t, flags=re.M)
    # 加粗/斜体：保留内容，去掉标记
    t = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", t, flags=re.S)
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S)
    # 行首的 > 引用块标记
    t = re.sub(r"^\s*>\s?", "", t, flags=re.M)
    # HTML 注释
    t = re.sub(r"<!--.*?-->", "", t, flags=re.S)
    # 连续 3 个以上空行压成 2 个
    t = re.sub(r"\n{4,}", "\n\n\n", t)
    return t


# 题干/解析开头的源文编号：只匹配开头一处，正文中间的不动。
# 覆盖：【题2】【题 2】【第2题】【第 2 题】，以及数据里自带的「五、(30分)」题头。
SOURCE_NUM_RE = re.compile(
    r"^\s*(?:"
    r"【\s*(?:题\s*[0-9０-９]+|第\s*[0-9０-９]+\s*题)\s*】"
    r"|[一二三四五六七八九十]+\s*[、.．]?\s*[（(]\s*[0-9０-９.]+\s*分\s*[)）]"
    r")\s*"
)


def strip_source_number(text: str) -> tuple[str, bool]:
    """去掉开头的【题N】/【第N题】；返回 (新文本, 是否命中)。"""
    s = text or ""
    new = SOURCE_NUM_RE.sub("", s, count=1)
    if new == s:
        return s, False
    # 去掉标记后紧跟的空白压掉，避免题干以空白/空行开头
    return re.sub(r"^\s+", "", new), True


def resolve_questions(paperset: dict, store: Store, img_dir: Path,
                      used: list | None = None,
                      clean_stats: dict | None = None) -> tuple[list[dict], list[str]]:
    """取题、清理 Markdown、把图片复制到 img_dir 并改写成 images/<文件名>。

    返回 (题目列表, 未取到清单)。题目列表的结构供 examtex 直接排版：
        {n, slug, qid, name, paper_name, score, content, analysis, answer, tags, note}

    注意：解析/答案**总是**读取。题卷用不到，但 --mode answers 需要；
    是否输出答案卷由 main() 的 mode 决定，不再由 show_analysis 控制内容取舍。
    """
    items = paperset.get("items") or []
    unresolved: list[str] = []
    questions: list[dict] = []

    def rewrite_images(text: str) -> str:
        """把 data/images/... 复制到 images/，返回替换后的 Markdown。"""
        def repl(m: re.Match) -> str:
            alt, rel = m.group(1), m.group(2)
            if rel.startswith(("http://", "https://")):
                return m.group(0)
            data, fname = store.image(rel)
            if data is None:
                # 取不到图不能整篇失败：图少一张总比出不了卷强。
                # 记进未取到清单，并把引用整个去掉（留着会让 LaTeX 直接报错停下）。
                unresolved.append(f"缺图 {rel}")
                return f"（图缺失：{fname}）"
            target = img_dir / fname
            if not target.exists():
                target.write_bytes(data)
            if used is not None and fname not in used:
                used.append(fname)
            return f"![{alt}](images/{fname})"

        return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl, text)

    for idx, it in enumerate(items, 1):
        slug, qid = it.get("paper"), it.get("qid")
        try:
            q = store.question(slug, qid)
            paper_name = store.paper(slug).get("name") or str(slug)
        except Exception as e:
            unresolved.append(f"{slug}#{qid}（{e}）")
            continue

        content, hit = strip_source_number(strip_sep(q.get("content") or ""))
        if hit and clean_stats is not None:
            clean_stats["content"] = clean_stats.get("content", 0) + 1
        content = rewrite_images(content)
        analysis = ""
        answer = ""
        for field in ("analysis", "answer"):
            txt = q.get(field) or ""
            if txt and "无官方解答" not in txt:
                if field == "analysis":
                    txt, hit = strip_source_number(strip_sep(txt))
                    if hit and clean_stats is not None:
                        clean_stats["analysis"] = clean_stats.get("analysis", 0) + 1
                    analysis = rewrite_images(txt)
                else:
                    answer = rewrite_images(strip_sep(txt))

        questions.append({
            "n": idx,
            "slug": slug,
            "qid": qid,
            "name": q.get("title") or "",
            "paper_name": paper_name,
            "score": it.get("score", it.get("points")),
            "content": content,
            "analysis": analysis,
            "answer": answer,
            "tags": q.get("tags") or [],
            "note": it.get("note") or "",
        })

    # 编号必须连续：中间若有一题取不到，不能让后面的题号跳号
    for i, q in enumerate(questions, 1):
        q["n"] = i

    return questions, unresolved


def build_questions_markdown(questions: list[dict], meta: dict, total_score: int = 0) -> str:
    """题卷的中间 Markdown（只含题干；便于排查）。"""
    title = meta.get("title") or "物理竞赛试卷"
    lines: list[str] = [f"# {title}\n"]

    n = len(questions)
    head = [f"共 {n} 题"]
    if total_score:
        head.append(f"满分 {total_score} 分")
    if meta.get("duration"):
        head.append(f"考试时间 {meta['duration']} 分钟")
    lines.append("　".join(head) + "\n")
    if meta.get("subtitle"):
        lines.append(meta["subtitle"] + "\n")

    for q in questions:
        score = q.get("score")
        score_txt = f"（{score} 分）" if score else ""
        lines.append(f"## {q['n']}．{q['paper_name']} 第 {q['qid']} 题{score_txt}\n")
        tags = q.get("tags") or []
        if tags:
            last = [t.split("/")[-1] for t in tags]
            lines.append("考点：" + "；".join(last) + "\n")
        if q.get("note"):
            lines.append(f"备注：{q['note']}\n")
        lines.append(q.get("content") or "")

    return "\n".join(lines) + "\n"


def build_answers_markdown(questions: list[dict], meta: dict) -> str:
    """答案卷的中间 Markdown（题干 + 解析/答案；便于排查）。"""
    title = meta.get("title") or "物理竞赛试卷"
    lines: list[str] = [f"# {title}（参考答案）\n", f"共 {len(questions)} 题\n"]

    for q in questions:
        lines.append(f"## {q['n']}．{q['paper_name']} 第 {q['qid']} 题\n")
        lines.append(q.get("content") or "")
        lines.append("解析：")
        if (q.get("analysis") or "").strip():
            lines.append(q["analysis"])
        else:
            lines.append("（暂无解析）")
        if (q.get("answer") or "").strip():
            lines.append("答案：")
            lines.append(q["answer"])

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# LaTeX 导言区（在 md2latex 产物基础上补齐缺字回退）

def _norm_family(name: str) -> str:
    """字体家族名归一化：忽略大小写与空白，便于跨平台比对。"""
    return re.sub(r"\s+", "", name or "").strip().lower()


# 常见字体目录（三平台都放进来，不存在的直接跳过）
FONT_DIRS = [
    Path(r"C:\Windows\Fonts"),
    Path.home() / "AppData/Local/Microsoft/Windows/Fonts",
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
    Path.home() / ".fonts",
    Path.home() / ".local/share/fonts",
    Path("/System/Library/Fonts"),
    Path("/Library/Fonts"),
]

_FONT_SUFFIXES = (".ttf", ".ttc", ".otf", ".otc")


def _scan_font_files() -> list[Path]:
    """列出字体目录里的字体文件（只扫描文件名，不解剖字体）。"""
    files: list[Path] = []
    for d in FONT_DIRS:
        if not d.is_dir():
            continue
        for suffix in _FONT_SUFFIXES:
            files.extend(d.rglob("*" + suffix))
    return files


def _fc_list() -> list[tuple[str, str]]:
    """Linux/macOS：用 fontconfig 列 (字体文件, 家族名)；没有 fc-list 返回空。

    GitHub Actions 装完 fonts-noto-cjk 后 fc-list 一定有；这条路径不需要 fontTools。
    """
    exe = shutil.which("fc-list")
    if not exe:
        return []
    try:
        r = subprocess.run([exe, "--format", "%{file}\t%{family}\n"],
                           capture_output=True, timeout=30)
    except Exception:
        return []
    if r.returncode != 0:
        return []
    rows: list[tuple[str, str]] = []
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        if "\t" not in line:
            continue
        path, fams = line.split("\t", 1)
        for fam in fams.split(","):
            fam = fam.strip()
            if fam:
                rows.append((path.strip(), fam))
    return rows


def _installed_families() -> dict[str, tuple[str, Path | None]]:
    """已安装字体：归一化家族名 → (显示名, 字体文件或 None)。

    优先 fontconfig（Linux/macOS，准且快）；没有就扫字体目录读 name 表；
    再不行才用文件名兜底猜。
    """
    found: dict[str, tuple[str, Path | None]] = {}

    for path, fam in _fc_list():
        found.setdefault(_norm_family(fam), (fam, Path(path) if path else None))
    if found:
        return found

    files = _scan_font_files()
    try:
        from fontTools.ttLib import TTFont  # type: ignore
    except Exception:
        for f in files:
            found.setdefault(_norm_family(f.stem), (f.stem, f))
        return found

    for f in files:
        try:
            ft = TTFont(str(f), fontNumber=0, lazy=True)
            name = ""
            for rec in ft["name"].names:
                if rec.nameID == 1:
                    name = rec.toUnicode()
                    break
            ft.close()
            if name:
                found.setdefault(_norm_family(name), (name, f))
        except Exception:
            continue
    return found


def _font_coverage(font_file: Path | None) -> float | None:
    """回退字符集在该字体里的覆盖率；读不到 cmap 返回 None（不做判断）。"""
    if font_file is None:
        return None
    try:
        from fontTools.ttLib import TTFont  # type: ignore
    except Exception:
        return None
    try:
        ft = TTFont(str(font_file), fontNumber=0, lazy=True)
        cmap: set[int] = set()
        for table in ft["cmap"].tables:
            cmap.update(table.cmap.keys())
        ft.close()
    except Exception:
        return None
    need = {ord(c) for c in FALLBACK_CHARS}
    return len(need & cmap) / len(need)


def pick_fallback_font() -> str | None:
    """挑一个系统里**确实存在**、并尽量覆盖回退字符的字体。

    按 FALLBACK_FONTS 的优先级在「已安装字体」里找：Windows 上命中 MS Mincho，
    Linux / Actions 上没有它就自动落到 Noto CJK —— 不会硬用不存在的第一个。
    覆盖率达到 95% 就直接用；都不达标时用其中覆盖最高的那个（总比没有强）。
    """
    installed = _installed_families()
    best: tuple[float, str] | None = None
    for want in FALLBACK_FONTS:
        entry = installed.get(_norm_family(want))
        if not entry:
            continue
        display, path = entry
        cov = _font_coverage(path)
        if cov is None:
            # 读不到 cmap（CI 上常常没装 fontTools）：字体确实存在就先用，
            # LaTeX 端还有 \IfFontExistsTF 兜底。
            return display
        if cov >= 0.95:
            return display
        if best is None or cov > best[0]:
            best = (cov, display)
    if best:
        log(f"   ⚠ 回退字体覆盖率最高只有 {best[0] * 100:.0f}%，使用 {best[1]}")
        return best[1]
    return None


def inject_preamble(tex_path: Path, font: str | None) -> int:
    """保留旧接口（已不再使用）：缺字回退现在由 examtex.py 的导言区负责。"""
    return 0


# ---------------------------------------------------------------------------
# 编译

def run(cmd: list[str], cwd: Path, timeout: int = 600) -> tuple[int, str]:
    log("  编译中…")
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout)
    out = r.stdout.decode("utf-8", errors="replace") + r.stderr.decode("utf-8", errors="replace")
    return r.returncode, out


def compile_pdf(work: Path, stem: str, passes: int = 2) -> tuple[bool, dict]:
    """跑两遍 xelatex（第二遍为了交叉引用与目录）。"""
    info = {"pages": None, "missing": [], "overfull": 0, "overfull_vbox": 0, "error": None}
    pdf = work / f"{stem}.pdf"

    # ⚠️ 先删掉旧 PDF：否则上一轮遗留的文件会让「编译失败」被误判成成功
    # （实测踩过：编译报错，但目录里还躺着一个 0 KB 的旧 pdf）。
    if pdf.exists():
        try:
            pdf.unlink()
        except OSError:
            pass

    for i in range(passes):
        code, out = run(["xelatex", "-interaction=nonstopmode", f"{stem}.tex"], work)
        if code != 0:
            for line in out.splitlines():
                if line.startswith("!"):
                    info["error"] = line.strip()
                    break
            if info["error"]:
                return False, info

    logfile = work / f"{stem}.log"
    if logfile.is_file():
        lt = logfile.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"Output written on .*?\((\d+) pages?", lt)
        if m:
            info["pages"] = int(m.group(1))
        info["missing"] = sorted(set(re.findall(r"Missing character: There is no (.)", lt)))
        info["overfull"] = len(re.findall(r"Overfull \\[hv]box", lt))
        info["overfull_vbox"] = len(re.findall(r"Overfull \\vbox", lt))

    # 必须真的产出了非空 PDF 才算成功
    if not pdf.is_file() or pdf.stat().st_size == 0:
        if not info["error"]:
            info["error"] = "xelatex 未产出 PDF（日志见 .log）"
        return False, info

    return True, info


# ---------------------------------------------------------------------------
# 自检

def selfcheck() -> None:
    ensure_tex_on_path()
    log("=== 环境自检 ===")
    ok = True

    # 只有 xelatex 是硬要求；pdfinfo / pdftoppm 只是辅助（Actions 上没装也不影响出卷）
    for exe, fatal in (("xelatex", True), ("pdfinfo", False), ("pdftoppm", False)):
        p = shutil.which(exe)
        if p:
            mark = "✓ " + p
        else:
            mark = "✗ 未找到" if fatal else "— 未找到（可选，不影响出卷）"
        log(f"  {exe:12s} {mark}")
        ok = ok and (bool(p) or not fatal)

    if MD2LATEX.is_file():
        log(f"  md2latex.py  ✓ {MD2LATEX}")
    else:
        log(f"  md2latex.py  ✗ 找不到 {MD2LATEX}")
        ok = False

    if (HERE / "examtex.py").is_file():
        log(f"  examtex.py   ✓ {HERE / 'examtex.py'}")
    else:
        log(f"  examtex.py   ✗ 找不到 {HERE / 'examtex.py'}")
        ok = False

    log(f"  本地数据     {'✓ ' + str(REPO / 'data') if (REPO / 'data').is_dir() else '— 无，将联网拉取'}")

    font = pick_fallback_font()
    if font:
        log(f"  符号回退字体 ✓ {font}")
    else:
        # 找不到回退字体**不是致命错误**：照样能出卷，只是 ①②/Ⅰ/℃ 等可能缺字。
        # GitHub Actions 上没有 MS Mincho 是常态（会自动改用 Noto CJK），
        # 两边都没有时只提示，不让自检失败。
        log("  符号回退字体 ⚠ 没探测到可用字体（①②/Ⅰ/℃ 等可能缺字，不影响出卷）")

    log()
    log("自检" + ("通过 ✓" if ok else "未通过 ✗"))
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------------------
# 主流程

def main() -> None:
    ensure_tex_on_path()
    ap = argparse.ArgumentParser(description="读选题目录，出 PDF 试卷")
    ap.add_argument("paperset", nargs="?", help="paperset.json 路径")
    ap.add_argument("-o", "--out", default=None, help="输出目录（默认 out/<标题>）")
    ap.add_argument("--tex-only", action="store_true", help="只生成 .tex，不编译")
    ap.add_argument("--offline", action="store_true", help="只用本地数据")
    ap.add_argument("--check", action="store_true", help="自检环境后退出")
    ap.add_argument("--mode", choices=("both", "questions", "answers"), default=None,
                    help="输出哪份文档：both/questions/answers（默认 both；show_analysis 为假时只出题卷）")
    args = ap.parse_args()

    if args.check:
        selfcheck()
        return

    if not args.paperset:
        die("请给出 paperset.json 路径（用 --check 可先自检环境）")
    src = Path(args.paperset)
    if not src.is_file():
        die(f"找不到文件：{src}")
    if not MD2LATEX.is_file():
        die(f"找不到 {MD2LATEX}（examtex 复用其转义能力）")

    sys.path.insert(0, str(HERE))
    try:
        import examtex
    except Exception as e:  # pragma: no cover
        die(f"examtex.py 加载失败：{e}")

    paperset = json.loads(src.read_text(encoding="utf-8"))
    if paperset.get("format") != "wasio-paperset":
        die("这不是本站导出的选题目录（format 字段不匹配）")
    items = paperset.get("items") or []
    if not items:
        die("目录里没有任何题目")

    meta = paperset.get("meta") or {}
    title = meta.get("title") or "物理竞赛试卷"
    safe = re.sub(r'[\\/:*?"<>|]', "_", title).strip() or "试卷"

    # 默认两份都出；老 paperset 没开 show_analysis 时按老语义只出题卷。
    # 命令行显式 --mode 优先于 show_analysis。
    mode = args.mode or ("both" if meta.get("show_analysis") else "questions")

    # 必须解析成绝对路径：编译时 cwd 会切到 outdir；相对路径（如 `_out`）
    # 会让后续读写再套一层目录。
    outdir = Path(args.out).resolve() if args.out else (HERE / "out" / safe)
    outdir.mkdir(parents=True, exist_ok=True)
    img_dir = outdir / "images"
    img_dir.mkdir(exist_ok=True)

    docs: list[tuple[str, str]] = []
    if mode in ("both", "questions"):
        docs.append(("questions", f"{safe}·题卷"))
    if mode in ("both", "answers"):
        docs.append(("answers", f"{safe}·答案卷"))

    log("=== 出卷 ===")
    log(f"  目录    : {src}")
    log(f"  标题    : {title}")
    log(f"  题目数  : {len(items)}")
    log(f"  模式    : {mode}（" + " / ".join("题卷" if k == "questions" else "答案卷"
                                          for k, _ in docs) + "）")
    log(f"  输出到  : {outdir}")
    log(f"  题库路径: {REPO / 'data'}")
    log()

    store = Store(offline=args.offline)

    log("① 取题目、复制图片")
    used_imgs: list[str] = []
    clean_stats: dict = {}
    questions, unresolved = resolve_questions(paperset, store, img_dir, used_imgs, clean_stats)
    total_score = sum((q.get("score") or 0) for q in questions
                      if isinstance(q.get("score"), (int, float)))
    log(f"   数据来源：本地 {store.local_hits} 份 / 网络 {store.net_hits} 份")
    log(f"   题目 {len(questions)} 道；图片 {len(used_imgs)} 张")
    log(f"   源文题号清洗：题干 {clean_stats.get('content', 0)} 处；"
        f"解析 {clean_stats.get('analysis', 0)} 处")
    if unresolved:
        log(f"   ⚠ 有 {len(unresolved)} 处未取到：")
        for u in unresolved[:8]:
            log(f"       - {u}")
        if len(unresolved) > 8:
            log(f"       … 其余 {len(unresolved)-8} 处")
    if not questions:
        die("所有题目都没取到，无法出卷")

    log()
    log("② 生成 LaTeX（examtex.py：卷头 / 题号 / 分页 / 图片版式）")
    font = pick_fallback_font()
    if font:
        log(f"   缺字回退：{font}")
    else:
        # 没探测到时不给死路：examtex 的导言区会用 \IfFontExistsTF 在编译时再试候选表。
        log("   缺字回退：Python 端未探测到，交给 LaTeX 编译时探测（候选表兜底）")

    pending: list[dict] = []
    for kind, stem in docs:
        if kind == "questions":
            md = build_questions_markdown(questions, meta, total_score)
            tex, texinfo = examtex.build_exam_tex(questions, meta, font, img_dir, kind="questions")
        else:
            md = build_answers_markdown(questions, meta)
            tex, texinfo = examtex.build_exam_tex(questions, meta, font, img_dir, kind="answers")

        md_path = outdir / f"{stem}.md"
        md_path.write_text(md, encoding="utf-8")
        tex_path = outdir / f"{stem}.tex"
        tex_path.write_text(tex, encoding="utf-8")
        pending.append({"kind": kind, "stem": stem, "tex": tex,
                        "texinfo": texinfo, "md_path": md_path, "tex_path": tex_path})

        if kind == "questions":
            log(f"   · 题卷：预计 {texinfo['pages']} 页；每页题数 {texinfo['groups']}；"
                f"每页统一留白 {texinfo['blanks']} cm")
            for i, (body, blank, subq, fill) in enumerate(texinfo.get("detail") or [], 1):
                log(f"       第 {i} 题：正文 {body} cm + 书写留白 {blank} cm"
                    f"（小问 {subq}，{'填空/读数类' if fill else '计算证明类'}）")
        else:
            log(f"   · 答案卷：{len(questions)} 节，按内容自然连排")
        rep = texinfo["report"]
        if rep.warnings:
            for w in rep.warnings[:4]:
                log(f"       · {w}")

    if args.tex_only:
        log()
        for p in pending:
            log(f"已生成 {p['tex_path']}（--tex-only，未编译）")
        return

    log()
    log("③ 编译 PDF（xelatex ×2）")
    compiled: list[dict] = []
    all_ok = True
    for p in pending:
        ok, info = compile_pdf(outdir, p["stem"])
        compiled.append({"ok": ok, "info": info, **p})
        all_ok = all_ok and ok

    log()
    log("=== 结果 ===")
    for p in compiled:
        info = p["info"]
        if p["ok"]:
            pdf = outdir / f"{p['stem']}.pdf"
            log(f"  ✓ {p['stem']} : {pdf}")
            log(f"      页数 {info['pages']}；体积 {pdf.stat().st_size/1024:.0f} KB")
        else:
            log(f"  ✗ {p['stem']} 编译失败：{info['error']}")
            log(f"    可看日志：{outdir / (p['stem'] + '.log')}")

        if info["missing"]:
            log(f"      ⚠ 缺字：{''.join(info['missing'])}（{len(info['missing'])} 种）")
        if info["overfull"]:
            log(f"      · 排版溢出 {info['overfull']} 处"
                + (f"（其中 vbox {info['overfull_vbox']} 处）" if info["overfull_vbox"] else ""))

    log()
    log(f"中间文件都在 {outdir}（.md / .tex / .log），便于排查。")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    _force_utf8()
    main()
