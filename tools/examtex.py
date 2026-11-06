"""试卷 LaTeX 模板生成器（pdfgen.py 专用）。

不沿用 md2latex.py 的整篇模板，只借用它的：
  - 正文转义（escape_text / _escape_plain）
  - 行内 / 行间公式切分与清理（split_segments / clean_math）
  - 表格单元格转换（_cell_to_latex）

本模块自己负责：试卷导言区、卷头、题号、分页、图片版式、解析公式编号。

设计要点（以官方 CPhO 卷为参照，见 出卷版式规范.md）：
  - 题卷与答案卷是两份独立文档：题卷只排题干；答案卷是「题干+解析+答案」完整版。
  - 题卷分页按「**书写留空**」评估，不是「塞得下就塞」：
        判断题：Σ(正文高度) + N × 同页统一留白 ≤ 可用高度
    留白按题型分三档（填空 0.5cm / 一般 4.5cm 起、每个小问 +1.5cm、上限 8cm）。
    同页留白取该页最大值，用 \\vfill 均分到各题之间 —— 视觉上每题下方空隙一致，
    且整页撑满到页脚上方。放不下就少放：首页 2–3 题，长题一题一页，绝不压缩留白硬塞。
  - 题号用中文序数「一、（45 分）」，与官方一致。
  - 图片：**该题只有 1 张** → wrapfigure 右置 0.30 页宽、文字左绕、图注在图下；
    **≥2 张** → 不绕排，下方并排（每行最多 2 张，各 0.30 页宽），图注各自在下。
    极窄高图（w/h < 0.6）不绕排，单独居中、可放宽到 0.45。
  - 答案卷：按内容自然连排，只在题头/「解析：」/「答案：」前加 \\needspace 防孤行。
"""

from __future__ import annotations

import math
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 复用 MinerU/md2latex.py 的转换能力（不跑它的模板）

# md2latex.py 定位：入仓版本在 tools/ 里（与 examtex.py 同目录）优先；
# 仓库外布局仍用 MinerU 里的那份。找不到就直接把原因抛到 pdfgen 的 die()。
_LOCAL_MD2LATEX = Path(__file__).resolve().parent / "md2latex.py"
MD2LATEX = _LOCAL_MD2LATEX if _LOCAL_MD2LATEX.is_file() else Path(
    r"D:\Wasio\Workspace\MinerU\md2latex.py")
if str(MD2LATEX.parent) not in sys.path:
    sys.path.insert(0, str(MD2LATEX.parent))

try:
    import md2latex as M  # noqa: E402
except ImportError as _exc:  # pragma: no cover
    raise ImportError(
        f"examtex 需要 md2latex.py（转义 / 公式 / 表格能力），{MD2LATEX} 不可用；"
        f"把 md2latex.py 和 examtex.py 放在同一目录即可。原始错误：{_exc}"
    ) from _exc

try:  # 读图片像素尺寸用；没有 Pillow 时退回手写文件头解析
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover
    Image = None


# ---------------------------------------------------------------------------
# 版面常量

TEXT_WIDTH_PT = 470.0     # A4 21cm - 左右各 2.2cm = 16.6cm ≈ 470pt
TEXT_HEIGHT_PT = 718.0    # A4 29.7cm - 上下各 2.2cm = 25.3cm ≈ 718pt
LINE_PT = 15.6            # 10.5pt × 1.25 行距的近似基线
CHARS_PER_LINE = 40.0     # 10.5pt 中文每行约 42–44 字，取 40 保守估算

# —— 分页：按「书写留空」评估（不再用行数容量硬塞）——
TEXT_HEIGHT_CM = 25.3     # A4 29.7 − 上下各 2.2
TITLE_BLOCK_CM = 3.0      # 首页卷头占用（标题 + 副标题 + 元信息 + 间距）
PAGE_SAFE_CM = 0.6        # 估算安全余量：宁可少放一题，也不挤掉书写空间
LINE_CM = LINE_PT * 2.54 / 72.0   # ≈ 0.550cm

# 书写留白三档
BLANK_FILL_CM = 0.5       # 填空 / 实验读数题：几乎不留（题目自带横线）
BLANK_BASE_CM = 4.5       # 一般计算 / 证明题起手（4–6cm 取中）
BLANK_PER_SUB_CM = 1.5    # 每多一个小问追加
BLANK_MAX_CM = 8.0        # 留白上限

# 图片版式（对照官方：单图右侧约 30% 页宽绕排；多图下方并排各约 28%）
SINGLE_IMG_WIDTH = 0.30      # 单图缺省宽度
SINGLE_IMG_MIN_WIDTH = 0.26
SINGLE_IMG_MAX_WIDTH = 0.34
SINGLE_IMG_MAX_HEIGHT = 0.52  # 单图高度上限（防止一张图独占整页）
PAIR_IMG_WIDTH = 0.30        # 多图并排时每张宽度
PAIR_IMG_MAX_HEIGHT = 0.30
TALL_IMG_WIDTH = 0.45        # 极窄高图（w/h<0.6）单独居中时允许放宽
TALL_IMG_MAX_HEIGHT = 0.45
WRAP_TEXT_SHARE = 0.62       # 绕排后正文可用宽度比例（1 − 图宽 − 间距）
MIN_IMG_WIDTH = SINGLE_IMG_MIN_WIDTH
USE_WRAP = True              # 关掉可全局退化为「单图居中 0.30」（wrapfig 出问题时用）


_IMG_RE = re.compile(r"^!\[([^\]]*)\]\(\s*([^)\s]+?)(?:\s+\"[^\"]*\")?\s*\)$")
_TABLE_SEP_RE = re.compile(r"^\|[\s:|-]+\|$")
_CAPTION_RE = re.compile(r"^(?:图\s*[0-9０-９一二三四五六七八九十]|[（(][a-zA-Z][)）]\s*$)")
_CJK_PUNCT_RE = re.compile(r"[。，；：？！,;:?!]")

_DISPLAY_TEX_RE = re.compile(r"\\\[\s*(.+?)\s*\\\]", re.S)
_HEADING_TEX_RE = re.compile(
    r"\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^{}]*)\}"
)

# 希腊字母：SimSun 没有字形，统一走数学字体；其余缺字仍用回退字体
GREEK_MAP = {
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta",
    "ε": r"\varepsilon", "ζ": r"\zeta", "η": r"\eta", "θ": r"\theta",
    "ι": r"\iota", "κ": r"\kappa", "λ": r"\lambda", "μ": r"\mu",
    "ν": r"\nu", "ξ": r"\xi", "π": r"\pi", "ρ": r"\rho",
    "σ": r"\sigma", "τ": r"\tau", "υ": r"\upsilon", "φ": r"\varphi",
    "χ": r"\chi", "ψ": r"\psi", "ω": r"\omega",
    "ϕ": r"\phi", "ϵ": r"\epsilon",
    "Γ": r"\Gamma", "Δ": r"\Delta", "Θ": r"\Theta", "Λ": r"\Lambda",
    "Ξ": r"\Xi", "Π": r"\Pi", "Σ": r"\Sigma", "Φ": r"\Phi",
    "Ψ": r"\Psi", "Ω": r"\Omega",
}


# ---------------------------------------------------------------------------
# 小工具

def _plain_text(md: str) -> str:
    """题块「纯文本」长度：去掉图片、行间公式、表格与 Markdown 记号。"""
    s = md or ""
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"\$\$.*?\$\$", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"[#*>`_~|$\\{}]", "", s)
    return re.sub(r"\s+", "", s)


_IMG_FIND_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")

CN_DIGITS = "零一二三四五六七八九"


def cn_number(n: int) -> str:
    """题号用的中文序数：1→一，10→十，11→十一，20→二十，25→二十五。"""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n)
    if n <= 0:
        return str(n)
    if n < 10:
        return CN_DIGITS[n]
    if n < 20:
        return "十" + (CN_DIGITS[n % 10] if n % 10 else "")
    if n < 100:
        return CN_DIGITS[n // 10] + "十" + (CN_DIGITS[n % 10] if n % 10 else "")
    if n < 1000:
        head = CN_DIGITS[n // 100] + "百"
        rest = n % 100
        if rest == 0:
            return head
        if rest < 10:
            return head + "零" + CN_DIGITS[rest]
        return head + cn_number(rest)
    return str(n)


# 填空 / 实验读数题的识别：留白几乎为 0（题目自己带横线或表格）
_BLANK_MARK_RE = re.compile(r"[_＿]{2,}|\[\s{3,}\]|（\s{3,}）")
_EMPTY_PAREN_RE = re.compile(r"[（(][\s　]{0,4}[)）]")
_FILL_KW = ("填空", "填入", "填写", "填上", "填表", "读数", "估读")

# 小问计数：(1) （2） （2.1） （一） 都算；"(30分)" 这类不会被误计
_SUBQ_RE = re.compile(r"[（(]\s*(?:\d{1,2}(?:\.\d{1,2})?|[一二三四五六七八九十])\s*[)）]")


def is_fill_in(md: str) -> bool:
    """题面是否是填空 / 实验读数类（这类题不需要额外书写留白）。"""
    t = md or ""
    if _BLANK_MARK_RE.search(t):
        return True
    if _EMPTY_PAREN_RE.search(t):
        return True
    return any(k in t for k in _FILL_KW)


def count_subquestions(md: str) -> int:
    """用 (1)（2）（2.1） 的出现次数估算小问数。"""
    return len(_SUBQ_RE.findall(md or ""))


def blank_cm(q: dict) -> float:
    """该题需要的书写留白（cm）：填空≈0，一般题 4.5 起、每个小问 +1.5、上限 8。"""
    if q.get("_fill"):
        return BLANK_FILL_CM
    n = q.get("_subq") or 0
    return min(BLANK_MAX_CM, BLANK_BASE_CM + BLANK_PER_SUB_CM * max(0, n - 1))


def _pre_normalize(md: str) -> str:
    """把数据里混用的 LaTeX 定界符统一成 Markdown 形式。"""
    s = md or ""
    s = s.replace("\ufe0f", "")
    s = s.replace("⚠", "※")          # SimSun 无 U+26A0，换成常见符号
    # \[ ... \] → $$ ... $$（数据里的答案解析常用这种写法）
    s = re.sub(r"\\\[(.+?)\\\]", lambda m: "\n$$\n" + m.group(1).strip() + "\n$$\n", s, flags=re.S)
    # \( ... \) → $ ... $
    s = re.sub(r"\\\((.+?)\\\)", lambda m: "$" + m.group(1).strip() + "$", s, flags=re.S)
    return s


def _inline_tex(text: str, rep: M.LatexReport) -> str:
    """图注 / 卷头这类短文本的转义：支持行内公式。"""
    parts = []
    for kind, chunk in M.split_segments(text):
        if kind == "text":
            parts.append(M.escape_text(chunk, rep))
        elif kind == "inline":
            parts.append("$" + M.clean_math(chunk, rep) + "$")
        else:
            parts.append("\\[" + M.clean_math(chunk, rep) + "\\]")
    return "".join(parts).strip()


def _image_size(path: Path) -> tuple[int, int] | None:
    """读图片像素尺寸；读不到返回 None（按普通图片处理）。"""
    if Image is not None:
        try:
            with Image.open(path) as im:
                return im.size
        except Exception:
            pass
    try:  # 兜底：PNG 头（IHDR）
        data = path.read_bytes()[:64]
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            import struct
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
    except Exception:
        pass
    return None


def _aspect(img_path: Path) -> float:
    """宽高比 w/h；读不到按 1.0。"""
    size = _image_size(img_path)
    if not size or size[1] <= 0:
        return 1.0
    return size[0] / size[1]


def _natural_frac(img_path: Path) -> float:
    """按 96dpi 估算「不放大」的自然宽度占版心比例；读不到则不限制。"""
    size = _image_size(img_path)
    if not size or size[0] <= 0:
        return 9.0
    return (size[0] / 96.0 * 72.0) / TEXT_WIDTH_PT


def wrap_width_frac(img_path: Path) -> float:
    """单图右置宽度：0.30 起，按原始宽高比在 0.26–0.34 之间微调。"""
    ar = _aspect(img_path)
    if ar >= 2.0:
        frac = 0.34          # 很扁的图（示意图）可以略宽
    elif ar >= 1.3:
        frac = 0.32
    elif ar >= 0.75:
        frac = 0.30
    elif ar >= 0.6:
        frac = 0.28
    else:
        frac = 0.26          # 偏瘦高的图收窄，免得把正文挤成一条缝
    frac = min(frac, _natural_frac(img_path))
    return max(SINGLE_IMG_MIN_WIDTH, min(SINGLE_IMG_MAX_WIDTH, frac))


def _width_fraction(img_path: Path) -> float:
    """兼容旧调用：等同 wrap_width_frac。"""
    return wrap_width_frac(img_path)


def _img_lines(img_path: Path, width_frac: float, max_height_frac: float) -> float:
    """估算图片占用的行数（含图注与间距）。"""
    size = _image_size(img_path)
    if not size:
        return 6.0
    w, h = size
    if w <= 0 or h <= 0:
        return 6.0
    hp = (width_frac * TEXT_WIDTH_PT) * (h / w)
    hp = min(hp, max_height_frac * TEXT_HEIGHT_PT)
    return hp / LINE_PT + 1.2


# ---------------------------------------------------------------------------
# Markdown 块渲染

def _demote_headings(tex: str) -> str:
    """md2latex 会把 # 变成 \\section；试卷体里不需要章节标题，改成加粗行。"""
    def repl(m: re.Match) -> str:
        title = m.group(1).strip()
        return "\n\\par\\noindent\\textbf{" + title + "}\\par\n" if title else "\n"
    return _HEADING_TEX_RE.sub(repl, tex)


def _number_equations(tex: str) -> str:
    """把解析里的 \\[ ... \\] 换成 equation，得到右侧 (1)(2)… 编号。

    公式外层套 adjustbox{max width=\\linewidth}：超宽公式自动缩到版心内，
    避免 Overfull \\hbox 把公式推进页边距（实测短题答案卷有一处 33pt 溢出）。
    """
    def repl(m: re.Match) -> str:
        body = m.group(1).strip()
        body = re.sub(r"\\tag\*?\{[^{}]*\}", "", body).strip()
        if not body:
            return ""
        return ("\\begin{equation}\n"
                "\\begin{adjustbox}{max width=\\linewidth}\n"
                "$\\displaystyle " + body + "$\n"
                "\\end{adjustbox}\n"
                "\\end{equation}")
    return _DISPLAY_TEX_RE.sub(repl, tex)


def _split_pipe_row(row: str) -> list[str]:
    """拆 Markdown 表格行；**不拆 $...$ 内的竖线**（如 $|x|$）。"""
    s = row.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    cells: list[str] = []
    buf: list[str] = []
    in_math = False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s):
            buf.append(ch)
            buf.append(s[i + 1])
            i += 2
            continue
        if ch == "$":
            in_math = not in_math
        if ch == "|" and not in_math:
            cells.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf))
    return [c.strip() for c in cells]


def _render_table(rows: list[str], rep: M.LatexReport) -> str:
    """Markdown 管道表格 → tabularx。"""
    parsed = [_split_pipe_row(r) for r in rows]
    if len(parsed) >= 2 and _TABLE_SEP_RE.match(rows[1].strip()):
        header = parsed[0]
        body = parsed[2:]
    else:
        header = None
        body = parsed
    ncol = max([len(r) for r in parsed] + [1])
    spec = "|" + "|".join(["X"] * ncol) + "|"

    def fmt(cells: list[str]) -> str:
        cells = cells + [""] * (ncol - len(cells))
        return " & ".join(M._cell_to_latex(c, rep) for c in cells) + r" \\ \hline"

    lines = ["\\par\\vspace{0.4em}", "\\begin{center}\\small",
             "\\renewcommand{\\arraystretch}{1.25}",
             "\\begin{tabularx}{\\linewidth}{" + spec + "}", "\\hline"]
    if header is not None:
        lines.append(fmt(header))
    lines += [fmt(r) for r in body]
    lines += ["\\end{tabularx}", "\\end{center}", "\\vspace{0.2em}"]
    return "\n".join(lines) + "\n"


def _is_caption(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 40:
        return False
    if _IMG_RE.match(s) or s.startswith(("|", "#", ">", "$$")):
        return False
    if _CJK_PUNCT_RE.search(s):      # 图注一般不带句读；带句读的更像正文
        return False
    return bool(_CAPTION_RE.match(s))


def _caption_tex(img: dict, rep: M.LatexReport) -> str:
    cap = (img.get("caption") or "").strip()
    if not cap:
        return ""
    return "\\par\\vspace{0.2em}\n{\\small " + _inline_tex(cap, rep) + "}\n"


def _render_wrap(img: dict, img_dir: Path, rep: M.LatexReport) -> str:
    """单图右置：wrapfigure 绕排，图注在图正下方居中（对照官方「图 1a」）。"""
    p = img_dir / Path(img["path"]).name
    frac = wrap_width_frac(p)
    out = [
        "\\begin{wrapfigure}{r}{%.2f\\textwidth}\n" % frac,
        "\\vspace{-0.6\\baselineskip}\n",          # 让图顶与文字顶对齐，不那么突兀
        "\\centering\n",
        "\\includegraphics[width=\\linewidth,height=%.2f\\textheight,keepaspectratio]"
        "{\\detokenize{%s}}\n" % (SINGLE_IMG_MAX_HEIGHT, img["path"]),
        _caption_tex(img, rep),
        "\\end{wrapfigure}\n",
    ]
    return "".join(out)


def _render_centered(imgs: list[dict], rep: M.LatexReport,
                     frac: float, max_height_frac: float) -> str:
    """居中一组图：每行最多 2 张，图注各自在下（对照官方「图 4a」「图 4b」）。

    ⚠️ minipage 里的 \\textwidth 会被重定义为 minipage 宽度，所以内层必须用
    \\linewidth 并换算比例（踩过：0.30\\textwidth 套进 0.33 的 minipage 变成 0.10）。
    """
    out = ["\\par\\begin{center}\n"]
    pair = len(imgs) > 1
    box = 0.32
    inner = max(0.30, min(1.0, frac / box))
    for k, img in enumerate(imgs):
        if pair:
            out.append("\\begin{minipage}[t]{%.2f\\textwidth}\\centering\n" % box)
            out.append(
                "\\includegraphics[width=%.3f\\linewidth,height=%.2f\\textheight,keepaspectratio]"
                "{\\detokenize{%s}}\n" % (inner, max_height_frac, img["path"])
            )
        else:
            out.append(
                "\\includegraphics[width=%.2f\\textwidth,height=%.2f\\textheight,keepaspectratio]"
                "{\\detokenize{%s}}\n" % (frac, max_height_frac, img["path"])
            )
        out.append(_caption_tex(img, rep))
        if pair:
            out.append("\\end{minipage}")
            out.append("\\hspace{0.04\\textwidth}\n" if k + 1 < len(imgs) else "\n")
    out.append("\\end{center}\n")
    return "".join(out)


def _hoist_trailing_image(md: str) -> str:
    """题干末尾**单张**图 → 移到第一个正文段落之后。

    OCR 常把插图读成题干最后一块，那样既没有可绕排的正文，wrapfig 又会被
    挤到下一页压住下一题（实测）。官方卷的图都贴在正文右侧，这里近似还原：
    图挂到第一段之后，后面几段文字自然左绕。
    """
    lines = md.split("\n")
    last = len(lines) - 1
    while last >= 0 and not lines[last].strip():
        last -= 1
    if last < 0:
        return md
    if _IMG_RE.match(lines[last].strip()):
        blk_start = last
    else:                       # 末尾是图注，上一非空行是图片
        k = last - 1
        while k >= 0 and not lines[k].strip():
            k -= 1
        if k < 0 or not _IMG_RE.match(lines[k].strip()) or not _is_caption(lines[last]):
            return md
        blk_start = k
    if blk_start == 0:
        return md               # 整段只有图，没有正文可绕

    blk = [l for l in lines[blk_start:last + 1] if l.strip()]
    if sum(1 for l in blk if _IMG_RE.match(l.strip())) != 1:
        return md               # 末尾是多图块，交给「下方并排」

    first_blank = None
    for idx, l in enumerate(lines[:blk_start]):
        if idx > 0 and not l.strip():
            first_blank = idx
            break
    if first_blank is None:
        return md               # 只有一段正文，绕排会留大豁口，改居中

    merged = (lines[:first_blank] + [""] + blk + [""]
              + lines[first_blank:blk_start] + lines[last + 1:])
    return "\n".join(merged)


def _render_images(group: list[dict], img_dir: Path, rep: M.LatexReport,
                   allow_wrap: bool = USE_WRAP) -> str:
    """渲染一组图片。

    - 只有 1 张且不是极窄高图 → 右置绕排（官方做法）；
    - 极窄高图（w/h < 0.6）→ 单独居中，宽度可放宽到 0.45；
    - 2 张及以上 → 下方并排，每张 0.30 页宽，每行最多 2 张。
    """
    if not group:
        return ""

    if len(group) == 1:
        img = group[0]
        p = img_dir / Path(img["path"]).name
        if allow_wrap and _aspect(p) >= 0.6:
            return _render_wrap(img, img_dir, rep)
        frac = TALL_IMG_WIDTH if _aspect(p) < 0.6 else wrap_width_frac(p)
        maxh = TALL_IMG_MAX_HEIGHT if _aspect(p) < 0.6 else SINGLE_IMG_MAX_HEIGHT
        return _render_centered([img], rep, frac, maxh)

    out: list[str] = ["\\par\\vspace{0.35em}\n"]
    for start in range(0, len(group), 2):
        row = group[start:start + 2]
        out.append(_render_centered(row, rep, PAIR_IMG_WIDTH, PAIR_IMG_MAX_HEIGHT))
    out.append("\\par\\vspace{0.15em}\n")
    return "".join(out)


def _group_height_lines(group: list[dict], img_dir: Path) -> float:
    """估算一组图片占用的行数（用于避免图片单独被挤到下一页）。"""
    total = 0.0
    for k in range(0, len(group), 2):
        row = group[k:k + 2]
        if len(row) == 2:
            total += max(_img_lines(img_dir / Path(g["path"]).name,
                                    PAIR_IMG_WIDTH, PAIR_IMG_MAX_HEIGHT)
                         for g in row)
        else:
            p = img_dir / Path(row[0]["path"]).name
            if _aspect(p) < 0.6:
                total += _img_lines(p, TALL_IMG_WIDTH, TALL_IMG_MAX_HEIGHT)
            else:
                total += _img_lines(p, wrap_width_frac(p), SINGLE_IMG_MAX_HEIGHT)
    return total


def _split_leading_needspace(tex: str) -> tuple[int | None, str]:
    """把 render_md 开头自动加的 \\needspace 拆出来，便于放到标签之前。"""
    m = re.match(r"\A\\needspace\{(\d+)\\baselineskip\}\n?", tex)
    if not m:
        return None, tex
    return int(m.group(1)), tex[m.end():]


def render_md(md: str, img_dir: Path, rep: M.LatexReport, numbered: bool = False,
              guard_images: bool = True, allow_wrap: bool = USE_WRAP,
              collect_images: bool = False) -> str:
    """把一段题目/解析 Markdown 转成试卷体 LaTeX。

    - 图片行单独抽出来渲染（单图右置绕排 / 多图下方并排，不走 md2latex）；
    - collect_images=True 时，本段所有图都**不就地排**，最后统一输出到末尾
      （「该题 ≥2 张图 → 下方并排」就用这个）；
    - 单图且是题目最后一块时，绕排没有可绕的正文，改为把图挂到最后一段之前
      （否则 wrapfig 会跨页跑到下一页，实测会压住下一题）；
    - 管道表格自己转 tabularx；其余正文交给 md2latex 的正文转换内核；
    - numbered=True 时把行间公式换成 equation（解析专用）。
    """
    md = _pre_normalize(md)
    if allow_wrap and not collect_images:
        md = _hoist_trailing_image(md)
    lines = md.split("\n")
    out: list[str] = []
    buf: list[str] = []
    collected: list[dict] = []
    i = 0
    last_text: dict | None = None
    last_img: dict | None = None

    def flush() -> None:
        nonlocal last_text, last_img
        if not buf:
            return
        chunk = "\n".join(buf)
        buf.clear()
        if not chunk.strip():
            return
        # 图注写在图后一小段文字之后（OCR 读序乱）：挂回上一张图，
        # 否则「图 1」会变成正文里孤零零的一行。
        rows = [l for l in chunk.rstrip().split("\n") if l.strip()]
        if (last_img and len(rows) >= 2 and _is_caption(rows[-1])
                and last_img["group"] and not last_img["group"][-1].get("caption")):
            last_img["group"][-1]["caption"] = rows[-1].strip()
            if last_img.get("idx") is not None:      # 就地排的图要重画一遍
                out[last_img["idx"]] = _render_images(last_img["group"], img_dir, rep,
                                                      allow_wrap=allow_wrap)
            chunk = "\n".join(chunk.rstrip().split("\n")[:-1])
            last_img = None
            if not chunk.strip():
                return
        tex, _ = M.markdown_to_latex(chunk, standalone=False, report=rep)
        tex = _demote_headings(tex)
        if numbered:
            tex = _number_equations(tex)
        last_text = {"idx": len(out), "chars": len(_plain_text(chunk)),
                     "forms": chunk.count("$$") // 2}
        last_img = None
        out.append(tex.strip() + "\n")

    while i < len(lines):
        raw = lines[i]
        s = raw.strip()

        # --- 图片（可连续多张，中间允许空行与短图注） ---
        m = _IMG_RE.match(s)
        if m:
            flush()
            group: list[dict] = []
            while i < len(lines):
                mm = _IMG_RE.match(lines[i].strip())
                if not mm:
                    break
                img = {"alt": mm.group(1).strip(), "path": mm.group(2).strip(), "caption": ""}
                i += 1
                j = i
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and _is_caption(lines[j]):
                    img["caption"] = lines[j].strip()
                    i = j + 1
                if not img["caption"]:
                    img["caption"] = img["alt"]
                group.append(img)
                j = i
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and _IMG_RE.match(lines[j].strip()):
                    i = j
                    continue
                break
            if collect_images:
                # 该题 ≥2 张图：不就地排，最后统一放题目末尾（下方并排）
                collected.extend(group)
                last_img = {"idx": None, "group": group}   # 图注仍可回挂
                continue

            if (guard_images and last_text and last_text["idx"] == len(out) - 1
                    and last_text["chars"] <= 260 and last_text["forms"] <= 2):
                # 图前只有一小段文字时，把这段文字和图绑在一起：
                # 避免文字排到页底、图片单独被挤到下一页（长题里实测会出现）。
                need = max(2, int(math.ceil(_group_height_lines(group, img_dir))) + 1)
                out[last_text["idx"]] = ("\\needspace{%d\\baselineskip}\n" % need
                                         + out[last_text["idx"]])
            last_text = None
            out.append(_render_images(group, img_dir, rep, allow_wrap=allow_wrap))
            last_img = {"idx": len(out) - 1, "group": group}
            continue

        # --- Markdown 管道表格 ---
        if s.startswith("|") and s.endswith("|"):
            j = i
            rows: list[str] = []
            while j < len(lines) and lines[j].strip().startswith("|") and lines[j].strip().endswith("|"):
                rows.append(lines[j])
                j += 1
            if len(rows) >= 2 and _TABLE_SEP_RE.match(rows[1].strip()):
                flush()
                last_text = None
                last_img = None
                out.append(_render_table(rows, rep))
                i = j
                continue

        buf.append(raw)
        i += 1

    flush()
    if collected:
        out.append(_render_images(collected, img_dir, rep, allow_wrap=False))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 分页判定

def measure(md: str) -> tuple[int, int, int]:
    """返回 (纯文本字符数, 行间公式数, 图片数)。"""
    md = _pre_normalize(md)
    return (
        len(_plain_text(md)),
        md.count("$$") // 2,
        len(re.findall(r"!\[[^\]]*\]\([^)]+\)", md)),
    )


def estimate_lines(q: dict, img_dir: Path) -> float:
    """估算题卷中该题占用的行数（**只算题干**，解析不在这份文档里）。

    单图走右置绕排：图占高度，图旁文字按剩余宽度折算，不叠加成全宽。
    """
    md = q.get("content") or ""
    text_chars, nform, _ = measure(md)
    text_lines = text_chars / CHARS_PER_LINE + 2.4 * nform
    head = 1.0  # 题号行

    paths = [img_dir / Path(m.group(1)).name for m in _IMG_FIND_RE.finditer(md)]
    if not paths:
        return head + text_lines + 0.6
    if len(paths) == 1:
        p = paths[0]
        if _aspect(p) < 0.6:
            return head + text_lines + _img_lines(p, TALL_IMG_WIDTH, TALL_IMG_MAX_HEIGHT) + 0.6
        ilines = _img_lines(p, wrap_width_frac(p), SINGLE_IMG_MAX_HEIGHT)
        return head + ilines + max(0.0, text_lines - WRAP_TEXT_SHARE * ilines) + 0.6

    rows = 0.0
    for k in range(0, len(paths), 2):
        row = paths[k:k + 2]
        rows += max(_img_lines(p, PAIR_IMG_WIDTH, PAIR_IMG_MAX_HEIGHT) for p in row)
    return head + text_lines + rows + 0.6


def estimate_body_cm(q: dict, img_dir: Path) -> float:
    """题卷里这道题的正文高度（cm）：题干排版 + 图片，不含书写留白。"""
    return estimate_lines(q, img_dir) * LINE_CM + 0.4


def classify(q: dict, img_dir: Path) -> None:
    """给题卷题目打标记：是否填空题、小问数、书写留白、正文高度。

    只考察题干：题卷不排解析，所以答案长短不该影响题卷合页。
    """
    md = q.get("content") or ""
    c_chars, c_form, c_img = measure(md)
    q["_content_chars"] = c_chars
    q["_formulas"] = c_form
    q["_images"] = c_img
    q["_fill"] = is_fill_in(md)
    q["_subq"] = count_subquestions(md)
    q["_blank"] = blank_cm(q)
    q["_body"] = estimate_body_cm(q, img_dir)
    q["_est"] = estimate_lines(q, img_dir)
    q["short"] = q["_body"] <= 6.0


def plan_pages(questions: list[dict]) -> list[dict]:
    """按「正文高度 + 同页统一书写留白」贪心装箱。

    判定：Σ(正文) + N × 同页留白 ≤ 可用高度。
    同页留白取该页所有题的最大值；放不下就少放，绝不压缩留白硬塞。
    """
    pages: list[dict] = []
    i, n = 0, len(questions)
    while i < n:
        avail = TEXT_HEIGHT_CM - (TITLE_BLOCK_CM if not pages else 0.0) - PAGE_SAFE_CM
        group = [i]
        used = questions[i]["_body"]
        blank = questions[i]["_blank"]
        j = i + 1
        while j < n:
            nb = max(blank, questions[j]["_blank"])
            body_sum = used + questions[j]["_body"]
            # 档位不混排：本页已是「要留白」的题，下一题却是填空/读数类
            # （留白小得多）时，宁可换页让它与同类挤在一起。
            # 否则填空会被按 4.5cm 计费，容易占满整页、末尾剩一道孤题。
            tier_break = (blank - questions[j]["_blank"] >= 2.0)
            if not tier_break and body_sum + (len(group) + 1) * nb <= avail:
                group.append(j)
                used = body_sum
                blank = nb
                j += 1
            else:
                break
        pages.append({"items": group, "blank": blank, "used": used,
                      "avail": avail, "overflow": used + blank > avail})
        i = j
    return pages


# ---------------------------------------------------------------------------
# 导言区 / 卷头 / 题块

def _font_chain_tex(names: list[str]) -> str:
    """生成 \IfFontExistsTF 嵌套：第一个「系统里真的装了」的字体定义 \symfont。"""
    def build(i: int) -> str:
        if i >= len(names):
            return ""
        name = names[i].replace("{", "").replace("}", "").replace("\\", "")
        return ("\\IfFontExistsTF{" + name + "}{\\newfontfamily\\symfont{" + name
                + "}}{" + build(i + 1) + "}")
    return build(0)


def _if_font_chain(cands: list[tuple[str, str]], final: str) -> list[str]:
    """生成「按顺序挑第一个已安装字体并执行对应命令」的 \\IfFontExistsTF 嵌套。

    整个表达式**放在一行**里，靠递归配对括号，避免手工数括号出错
    （手写多行 `{%` 版本踩过坑：括号不配对 → `! File ended while scanning use of \\use_i:nn`）。
    """
    def build(i: int) -> str:
        if i >= len(cands):
            return final
        name, cmd = cands[i]
        safe = name.replace("{", "").replace("}", "").replace("\\", "")
        return "\\IfFontExistsTF{" + safe + "}{" + cmd + "}{" + build(i + 1) + "}"

    return [build(0)]


def _preamble(font: str | None) -> str:
    lines = [
        "% !TEX program = xelatex",
        "% 由 pdfgen.py + examtex.py 生成：试卷版式（A4 / 五号 / 页脚页码）",
        r"\documentclass[UTF8,zihao=5]{ctexart}",
        r"\usepackage[a4paper,top=2.2cm,bottom=2.2cm,left=2.2cm,right=2.2cm]{geometry}",
        r"\usepackage{amsmath,amssymb}",
        r"\usepackage{graphicx}",
        r"\usepackage{adjustbox}",
        r"\usepackage{tabularx}",
        r"\usepackage{array}",
        r"\usepackage{lastpage}",
        r"\usepackage{fancyhdr}",
        r"\usepackage{needspace}",
        r"\usepackage{wrapfig}",
        r"\usepackage[hidelinks]{hyperref}",
        r"\usepackage{newunicodechar}",
        r"\pagestyle{fancy}",
        r"\fancyhf{}",
        r"\fancyfoot[C]{第~\thepage~页\hspace{0.5em}共~\pageref{LastPage}~页}",
        r"\renewcommand{\headrulewidth}{0pt}",
        r"\setlength{\parindent}{2em}",
        r"\setlength{\parskip}{0pt plus 2pt}",
        r"\linespread{1.25}",
        r"\setlength{\emergencystretch}{3em}",
        r"\tolerance=2000",
        r"\allowdisplaybreaks[2]",
        r"\setcounter{secnumdepth}{-2}",
        # 绕排：图与正文的间距，太挤会压字、太松会留大豁口
        r"\setlength{\intextsep}{6pt plus 2pt minus 1pt}",
        r"\setlength{\columnsep}{12pt}",
    ]

    # ---- 正文字体：必须显式指定，并逐级回退 ----
    # 不写时 ctexart 默认用 SimSun（Windows 自带、Linux/CI 没有）。
    # 在 GitHub Actions 上实测：中文能显示，但**西文、数字全部消失**
    # （「本卷共 3 题」→「本卷共题」，公式里的字母也没了）。
    lines.append("% ---- 正文字体（西文/数字）：按 Windows → TeX 自带 → Linux 常见 顺序回退 ----")
    lines += _if_font_chain(
        [
            ("Times New Roman", r"\setmainfont{Times New Roman}"),
            ("TeX Gyre Termes", r"\setmainfont{TeX Gyre Termes}"),
            ("Liberation Serif", r"\setmainfont{Liberation Serif}"),
            ("DejaVu Serif", r"\setmainfont{DejaVu Serif}"),
            ("Noto Serif", r"\setmainfont{Noto Serif}"),
            ("Noto Serif CJK SC", r"\setmainfont{Noto Serif CJK SC}"),
        ],
        final=r"\setmainfont{DejaVu Serif}",
    )
    lines.append("% ---- 正文字体（中文）：AutoFakeBold 保证 \\bfseries 有粗体 ----")
    lines += _if_font_chain(
        [
            ("SimSun", r"\setCJKmainfont[AutoFakeBold=2]{SimSun}"),
            ("Noto Serif CJK SC", r"\setCJKmainfont[AutoFakeBold=2]{Noto Serif CJK SC}"),
            ("Source Han Serif SC", r"\setCJKmainfont[AutoFakeBold=2]{Source Han Serif SC}"),
            ("FandolSong-Regular", r"\setCJKmainfont[AutoFakeBold=2]{FandolSong-Regular}"),
            ("AR PL UMing CN", r"\setCJKmainfont[AutoFakeBold=2]{AR PL UMing CN}"),
        ],
        final=r"",
    )
    lines.append("% ---- 无衬线（兜底），同样逐级回退 ----")
    lines += _if_font_chain(
        [
            ("SimHei", r"\setCJKsansfont[AutoFakeBold=2]{SimHei}"),
            ("Noto Sans CJK SC", r"\setCJKsansfont[AutoFakeBold=2]{Noto Sans CJK SC}"),
            ("Source Han Sans SC", r"\setCJKsansfont[AutoFakeBold=2]{Source Han Sans SC}"),
        ],
        final=r"",
    )
    # `\zh{}`：数学里放中文用它。`\text{}` 走西文字体，全角标点会缺字
    # （实测 `、` 在 Times New Roman 下报 Missing character 直接消失）。
    lines.append(
        r"\providecommand{\zh}[1]{\text{\CJKfamily{\CJKrmdefault}#1}}"
    )

    # ---- 缺字回退：圈号/罗马数字/上下标等 SimSun 缺字 ----
    # 字体在**编译时**再探测一次（fontspec 的 \IfFontExistsTF）：Python 端挑到的
    # 名字先试，不存在就按候选表依次退。这样 Linux / GitHub Actions 上没有
    # MS Mincho 也不会让 xelatex 直接报「font not found」。
    chain: list[str] = []
    for name in ([font] if font else []) + FALLBACK_FONTS:
        if name and name not in chain:
            chain.append(name)
    if chain:
        lines.append("% ---- 缺字回退字体（编译时探测，第一个实际存在的生效）----")
        lines.append(_font_chain_tex(chain))
        lines.append(r"\ifdefined\symfont")   # 一个候选都没有时，跳过下面的替换规则
        rules = []
        for ch in FALLBACK_CHARS:
            if ch in GREEK_MAP:
                continue
            rules.append(r"\newunicodechar{" + ch + r"}{\symfont " + ch + "}")
        for ch, cmd in GREEK_MAP.items():
            rules.append(r"\newunicodechar{" + ch + r"}{\ensuremath{" + cmd + "}}")
        lines += rules
        lines.append(r"\fi")
    lines += [r"\begin{document}", ""]
    return "\n".join(lines) + "\n"


def _title_block(meta: dict, n_items: int, rep: M.LatexReport, kind: str = "questions") -> str:
    title = _inline_tex(meta.get("title") or "物理竞赛试卷", rep)
    subtitle = _inline_tex(meta.get("subtitle") or "", rep)
    out = ["\\begin{center}", "{\\LARGE\\bfseries " + title + "\\par}"]
    if kind == "answers":
        out.append("\\vspace{0.35em}")
        out.append("{\\large 参考答案\\par}")
        if subtitle:
            out.append("\\vspace{0.45em}")
            out.append("{\\normalsize " + subtitle + "\\par}")
        out.append("\\vspace{0.8em}")
        out.append(f"本卷共 {n_items} 题\\par")
    else:
        head = f"本卷共 {n_items} 题"
        duration = meta.get("duration")
        if duration:
            head += f"　　考试时间 {duration} 分钟"
        if subtitle:
            out.append("\\vspace{0.5em}")
            out.append("{\\large " + subtitle + "\\par}")
        out.append("\\vspace{0.8em}")
        out.append(head + "\\par")
    out.append("\\end{center}")
    out.append("\\vspace{1.0em}")
    out.append("\\nopagebreak\n")
    return "\n".join(out) + "\n"


def _score_text(score) -> str:
    if score is None or score == "":
        return ""
    try:
        f = float(score)
        return str(int(f)) if f.is_integer() else str(f)
    except (TypeError, ValueError):
        return str(score)


def _question_head(q: dict) -> str:
    """题号行：中文序数 + 分值，对齐官方「一、（45 分）」。"""
    head = "\\par\\noindent\\textbf{%s、}" % cn_number(q["n"])
    score = _score_text(q.get("score"))
    if score:
        head += "（%s 分）" % score
    return head + "\\quad{}"


def _render_question(q: dict, meta: dict, img_dir: Path, rep: M.LatexReport) -> str:
    """题卷的一道题：只排题干，绝不排解析/答案。

    图片策略（对照官方）：
      - 只有 1 张图 → 右置绕排，文字左绕、图注在图下；
      - ≥2 张图 → 不绕排，全部收在题目末尾、下方并排（每行最多 2 张）。

    分页由 plan_pages 按「正文 + 书写留白」整体决定，这里不再用 \\needspace
    —— 那会在控制好的版面上再插一页，把留白算法打乱。
    """
    content = q.get("content") or ""
    n_img = len(_IMG_FIND_RE.findall(content))
    out: list[str] = [_question_head(q)]
    out.append(render_md(content, img_dir, rep,
                         guard_images=False,
                         allow_wrap=USE_WRAP and n_img == 1,
                         collect_images=n_img >= 2).lstrip("\n"))
    out.append("\n")
    return "".join(out)


def _render_answer(q: dict, meta: dict, img_dir: Path, rep: M.LatexReport) -> str:
    """答案卷的一道题：题干原文 + 图片 + 解析 + 答案（完整版，自然连排）。"""
    out: list[str] = []
    # 题头 + 至少 5 行内容才留在页底，否则整体推到下一页（防孤行）
    out.append("\\needspace{5\\baselineskip}\n")
    source = _inline_tex(str(q.get("paper_name") or q.get("slug") or ""), rep)
    qid = _inline_tex(str(q.get("qid") or ""), rep)
    out.append(_question_head(q) + "（%s 第 %s 题）\\par\n" % (source, qid))

    # 题干原文（含图片）——答案卷是完整版，便于对照。
    # 答案卷自然连排、可能随时分页，单图不绕排（wrapfig 跨页会错乱），改居中。
    out.append(render_md(q.get("content") or "", img_dir, rep, allow_wrap=False))

    analysis = (q.get("analysis") or "").strip()
    answer = (q.get("answer") or "").strip()
    analysis_tex = render_md(analysis, img_dir, rep, numbered=True) if analysis else ""
    answer_tex = render_md(answer, img_dir, rep) if answer else ""

    # render_md 可能因「图前短文字」在开头加 needspace；把它提到「解析：」标签之前，
    # 否则标签会单独留在页底（实测孤行）。
    n_need, analysis_tex = _split_leading_needspace(analysis_tex)
    out.append("\n\\needspace{%d\\baselineskip}\n" % max(4, n_need or 4))
    out.append("\\par\\vspace{0.7em}\n")
    out.append("\\noindent\\textbf{解析：}\\par\n")
    out.append("\\setcounter{equation}{0}\n")

    if analysis:
        out.append(analysis_tex)
    else:
        out.append("\\par\\noindent（暂无解析）\\par\n")

    if answer:
        n_need2, answer_tex = _split_leading_needspace(answer_tex)
        out.append("\n\\needspace{%d\\baselineskip}\n" % max(3, n_need2 or 3))
        out.append("\\par\\vspace{0.5em}\n")
        out.append("\\noindent\\textbf{答案：}")
        out.append(answer_tex.lstrip("\n"))
    out.append("\n\\par\\vspace{1.2em}\n")
    return "".join(out)


# ---------------------------------------------------------------------------
# 入口

def build_exam_tex(questions: list[dict], meta: dict, font: str | None, img_dir: Path,
                   kind: str = "questions") -> tuple[str, dict]:
    """生成一份试卷 .tex，返回 (tex, 统计信息)。

    kind="questions" 题卷（只题干）；kind="answers" 答案卷（题干+解析+答案的完整版）。
    """
    rep = M.LatexReport()
    parts = [_preamble(font), _title_block(meta, len(questions), rep, kind)]

    if kind == "answers":
        for q in questions:
            classify(q, img_dir)
            parts.append(_render_answer(q, meta, img_dir, rep))
        info = {"short": 0, "pages": None, "groups": [], "report": rep}
        parts.append("\n\\end{document}\n")
        return _cjk_text_fix("\n".join(parts)), info

    for q in questions:
        classify(q, img_dir)
    pages = plan_pages(questions)
    for pi, page in enumerate(pages):
        if pi > 0:
            parts.append("\\newpage\n\n")
        # 填空/读数页（留白很小）要**紧排**：整页本来就不满，
        # 再用 \vfill 会把两道题拉开十几厘米，反而像排版事故。
        # 这类页只用固定间距，多余空间留白在页面底部。
        tight = page["blank"] < 2.0
        for qi in page["items"]:
            parts.append(_render_question(questions[qi], meta, img_dir, rep))
            if tight:
                parts.append("\n\\par\\vspace{1.2em}\n")
            else:
                # 同一页每题后面都放一条 \vfill：LaTeX 会把整页剩余空间
                # 等分给这些 \vfill，于是每题下方的留白**完全一致**，且整页撑满到页脚。
                parts.append("\n\\par\\vfill\n")
    parts.append("\n\\end{document}\n")

    info = {
        "short": sum(1 for q in questions if q["short"]),
        "pages": len(pages),
        "groups": [len(p["items"]) for p in pages],
        "blanks": [round(p["blank"], 2) for p in pages],
        "detail": [(round(q["_body"], 2), round(q["_blank"], 2), q["_subq"], q["_fill"])
                   for q in questions],
        "report": rep,
    }
    return _cjk_text_fix("\n".join(parts)), info


def _cjk_text_fix(tex: str) -> str:
    r"""让数学区段里的中文走中文字体。

    两种情况都要处理，否则 PDF 里那个字直接消失
    （`Missing character: There is no 、 (U+3001) in font Times New Roman`）：

    1. `\text{中文}` —— `\text{}` 用的是**西文字体**，全角标点必然缺字；
    2. 公式里裸着的中文标点/汉字，如 `$m 、 Q 、 B_{0}$`（源数据里很常见）。

    统一改成 `\zh{…}`（导言区定义为 `\text{\CJKfamily{\CJKrmdefault}…}`）。
    """
    tex = _wrap_text_cjk(tex)
    return _wrap_math_cjk(tex)


def _match_brace(s: str, start: int) -> int:
    """s[start] 是 `{`，返回配对 `}` 的下标；不配对返回 -1。"""
    depth = 0
    for k in range(start, len(s)):
        if s[k] == "{":
            depth += 1
        elif s[k] == "}":
            depth -= 1
            if depth == 0:
                return k
    return -1


def _wrap_text_cjk(tex: str) -> str:
    r"""`\text{含中文}` → `\zh{含中文}`。"""
    out = []
    i = 0
    needle = r"\text{"
    while True:
        j = tex.find(needle, i)
        if j < 0:
            out.append(tex[i:])
            break
        brace = j + len(needle) - 1          # 指向 `{`
        k = _match_brace(tex, brace)
        if k < 0:
            out.append(tex[i:])
            break
        inner = tex[brace + 1:k]
        out.append(tex[i:j])
        out.append((r"\zh{" + inner + "}") if any(_is_cjk(c) for c in inner)
                   else tex[j:k + 1])
        i = k + 1
    return "".join(out)


def _wrap_math_cjk(tex: str) -> str:
    r"""把 `$…$` / `\[…\]` 里裸着的中文串包成 `\zh{…}`；已有的 `\zh{}` 原样跳过。"""
    out = []
    i = 0
    n = len(tex)
    while i < n:
        c = tex[i]
        if c == "\\" and tex.startswith(r"\[", i):
            k = tex.find(r"\]", i + 2)
            if k < 0:
                out.append(tex[i:])
                break
            out.append(r"\[" + _wrap_cjk_in_math(tex[i + 2:k]) + r"\]")
            i = k + 2
            continue
        if c == "$" and i + 1 < n and tex[i + 1] != "$":
            k = i + 1
            while k < n:
                if tex[k] == "\\":
                    k += 2
                    continue
                if tex[k] == "$":
                    break
                k += 1
            if k >= n:
                out.append(tex[i:])
                break
            out.append("$" + _wrap_cjk_in_math(tex[i + 1:k]) + "$")
            i = k + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _wrap_cjk_in_math(seg: str) -> str:
    """单个数学区段内部：把成串的中文包成 `\\zh{}`，跳过已有 `\\zh{…}` 的内容。"""
    out = []
    i = 0
    n = len(seg)
    while i < n:
        if seg.startswith(r"\zh{", i):
            k = _match_brace(seg, i + 3)
            if k > 0:
                out.append(seg[i:k + 1])
                i = k + 1
                continue
        if _is_cjk(seg[i]):
            j = i
            while j < n and _is_cjk(seg[j]):
                j += 1
            out.append(r"\zh{" + seg[i:j] + "}")
            i = j
            continue
        out.append(seg[i])
        i += 1
    return "".join(out)



def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF      # 汉字
        or 0x3400 <= o <= 0x4DBF   # 扩展 A
        or 0x3000 <= o <= 0x303F   # CJK 标点（、。「」等）
        or 0xFF00 <= o <= 0xFFEF   # 全角字符
    )



# 与 pdfgen 共用的缺字回退字符集 / 候选字体表
# （避免循环 import，这里复制一份常量；改 pdfgen.FALLBACK_FONTS 时同步改这里）
FALLBACK_FONTS = [
    "MS Mincho",
    "Noto Serif CJK SC",
    "Noto Sans CJK SC",
    "Source Han Serif SC",
    "MS Gothic",
    "Meiryo",
    "DejaVu Sans",
]

FALLBACK_CHARS = (
    "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
    "㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟"
    "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ"
    "℃℉△▲▽▼→←↑↓↔⇒⇔−±×÷≈≠≤≥∞∠⊥∥⊙∫∮∑∏√∛"
    "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"
    "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾"
    "─│┌┐└┘├┤┬┴┼"
)
