#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 本文件是仓库外 D:\Wasio\Workspace\MinerU\md2latex.py 的原样副本，
# 供 GitHub Actions / 纯 tools/ 环境独立运行 examtex.py（它复用本文件的
# 正文转义、公式切分、表格单元格转换能力）。上游改了就直接覆盖这份。
"""md2latex.py —— MinerU Markdown → LaTeX 中途转换器（最小但适定）。

**定位**：把（建议先经 `clean_markdown.py` 清洗的）MinerU Markdown 转成**可编译的
XeLaTeX 源文件**，服务"把解析结果排成 PDF / 讲义"这类常见需求。

**"适定"的含义**：只做能从 Markdown 结构**确定推出**的转换，不猜语义、不重写内容。
- 标题 → `\\chapter/\\section/\\subsection`（按 # 层级映射，可配置）；
- 行间公式 `$$...$$` → `\\[...\\]`；行内 `$...$` 原样保留；
- `<table>` → 带 `tabularx` 的表格环境（用 `&` / `\\\\` 重组）；
- 图片 `![](images/x.jpg)` → `\\includegraphics`，且**校验文件是否存在**（缺失只警告）；
- 正文特殊字符**正确转义**（`% # & _ { } ~ \\`），公式区**不转义**。

**关键正确性保证（全部来自对真实 MinerU 输出的实测）**：
1. `%` 在正文里真实存在（`100%`、`10%`），不转义会让 LaTeX 静默吃掉整行后半 —— 必须转义。
2. `~` 在正文里以 `15\\~18`（页码范围）形式出现 —— 转成 `--`，不比 `\\textasciitilde` 差且更美观。
3. 中文出现在公式内时**必定**包在 `\\text{}` 里（实测 0 例外）—— 所以只做结构性处理，
   且 `\\text { 中文 }` 里多余空格要清掉，否则渲染出多余间隙。
4. 数学区与正文区的转义规则**完全不同** —— 本模块按区段切分后再分别处理，
   绝不对公式内部做 `%`/`#` 之类的转义（会破坏公式）。

**用法**：
    python md2latex.py in.md -o out.tex
    python md2latex.py in.md -o out.tex --doc-class ctexart --toc
    python md2latex.py in.md --report          # 只报告统计，不写文件
    python md2latex.py <dir> -o texout/        # 目录批量

零第三方依赖。
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

__all__ = ["markdown_to_latex", "LatexReport", "convert_file", "split_segments"]

# --------------------------------------------------------------------------
# 报告
# --------------------------------------------------------------------------
class LatexReport:
    """转换统计：便于验收（尤其"未映射"项必须为 0 才敢编译）。"""

    def __init__(self) -> None:
        self.counts: Counter = Counter()
        self.warnings: List[str] = []

    def hit(self, key: str, n: int = 1) -> None:
        if n:
            self.counts[key] += n

    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)

    def as_dict(self) -> Dict[str, int]:
        return dict(self.counts)

    def __str__(self) -> str:
        if not self.counts:
            return "（无内容）"
        width = max(len(k) for k in self.counts)
        out = "\n".join(f"  {k:<{width}}  {v}" for k, v in sorted(self.counts.items()))
        if self.warnings:
            out += "\n  警告:\n" + "\n".join(f"    - {w}" for w in self.warnings)
        return out


# --------------------------------------------------------------------------
# 正文转义：只对"正文区段"生效
# --------------------------------------------------------------------------
# LaTeX 正文（Latin Modern 正文字体）**没有**这些 Unicode 字形，实测会报
# `Missing character: There is no ⇒ (U+21D2) in font ...`。故先做符号映射，
# 能变成 LaTeX 命令的就变，剩下的保留原字（ctex 环境下多数中文相关字符可排）。
_UNICODE_MAP: Tuple[Tuple[str, str], ...] = (
    # 箭头
    ("⇒", r"$\Rightarrow$"), ("⇐", r"$\Leftarrow$"),
    ("→", r"$\rightarrow$"), ("←", r"$\leftarrow$"),
    ("↔", r"$\leftrightarrow$"), ("⇔", r"$\Leftrightarrow$"),
    # 集合 / 关系
    ("∈", r"$\in$"), ("∉", r"$\notin$"), ("⊂", r"$\subset$"), ("⊆", r"$\subseteq$"),
    ("∪", r"$\cup$"), ("∩", r"$\cap$"), ("∅", r"$\varnothing$"),
    ("∀", r"$\forall$"), ("∃", r"$\exists$"),
    ("≤", r"$\leq$"), ("≥", r"$\geq$"), ("≠", r"$\neq$"), ("≈", r"$\approx$"),
    ("∞", r"$\infty$"), ("∑", r"$\sum$"), ("∏", r"$\prod$"), ("√", r"$\sqrt{}$"),
    ("±", r"$\pm$"), ("×", r"$\times$"), ("÷", r"$\div$"), ("·", r"$\cdot$"),
    # 排版符号
    ("§", r"\S{}"), ("¶", r"\P{}"), ("†", r"\textdagger{}"),
    ("…", r"\ldots{}"),
    # 全角标点 → 半角（LaTeX 对全角句点支持不稳）
    ("．", "."), ("％", r"\%"),
    # 空心方块 / 勾选框：MinerU 把教材里的"□ 理解…"当列表符，统一成 \square
    ("□", r"$\square$"), ("☐", r"$\square$"),
    # 实测仍会报 Missing character 的零星符号（Latin Modern 无字形）
    ("♡", r"$\heartsuit$"), ("♢", r"$\diamondsuit$"), ("♣", r"$\clubsuit$"),
    ("ⓞ", "(o)"), ("ⓐ", "(a)"), ("ⓑ", "(b)"), ("ⓒ", "(c)"), ("ⓓ", "(d)"),
    ("̃", ""),   # U+0303 组合波浪号：孤立出现时无意义，直接丢弃
)

# 带圈数字（①②…⑳ ⑴…⑽）：LaTeX 无直接字形，退化为 (1) 形式最稳
_CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
_PAREN_NUM = "⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽"


def _map_unicode(s: str, rep: Optional[LatexReport] = None) -> str:
    """正文里的特殊 Unicode → LaTeX。映射表覆盖实测全部"缺字形"字符。"""
    for ch, tex in _UNICODE_MAP:
        if ch in s:
            if rep:
                rep.hit(f"Unicode 映射 {ch!r}", s.count(ch))
            s = s.replace(ch, tex)

    for i, ch in enumerate(_CIRCLED, start=1):
        if ch in s:
            if rep:
                rep.hit("带圈数字 → (n)", s.count(ch))
            s = s.replace(ch, f"({i})")
    for i, ch in enumerate(_PAREN_NUM, start=1):
        if ch in s:
            if rep:
                rep.hit("带圈数字 → (n)", s.count(ch))
            s = s.replace(ch, f"({i})")
    return s


def _strip_inline_math(s: str) -> str:
    """挖掉一段文本里的行内公式 `$...$`，返回剩余内容。

    用于区分"这段文字里的数学都已经在 $...$ 里了"（→ 正文，不该再包 `\\[`）
    与"这段文字里还有裸的公式内容"（→ 漏网公式，需要包 `\\[`）。
    """
    return re.sub(r"(?<!\$)\$(?!\$)[^$\n]*?(?<!\$)\$(?!\$)", "", s)


def _has_bare_math(s: str) -> bool:
    """判断这段文本是否含**裸**公式内容（行长内公式之外的真公式片段）。

    这是上一版的关键缺陷所在：`$\\{0,1,\\cdots,n\\}$` 里的 `\\cdots` 会命中公式
    特征，但它是**已配对的行内公式**，不该再整段包进 `\\[`。实测该误判让一个正文
    段落被追加了孤立的 `\\[`，导致全文 `\\[`/`\\]` 失衡并引发一连串编译错误。
    """
    return bool(_STRONG_MATH_RE.search(_strip_inline_math(s)))


def _split_prose_and_math(line: str) -> Tuple[str, str]:
    """把"正文与公式粘连在同一行"的情况拆开，返回 (正文, 公式)。

    真实反例（MinerU 实测输出）：

        设离散型随机变量 X 所有可能取值为 $\\{0,1,\\cdots,n\\}$ ，0 m + n \\mid X > m) = P (X > n).\\tag{2.10}

    前 half 是正文，后半是另一条公式的残片被粘了上来。整体当公式会报
    `Display math should end with $$`；整体当正文又会丢掉公式。
    这里按"最后一个行内公式的结束位置"切分：它之前是正文，之后是公式残片。
    """
    st = line.rstrip()
    matches = list(re.finditer(r"(?<!\$)\$(?!\$)[^$\n]*?(?<!\$)\$(?!\$)", st))
    if not matches:
        return st, ""
    last = matches[-1]
    head, tail = st[:last.end()], st[last.end():]
    # 仅当尾部确实含 LaTeX 命令时才切（否则整行都是正文）
    if "\\" in tail:
        return head, tail
    return st, ""


def _line_is_prose(line: str) -> bool:
    """判断 `$$` 块内的一行是否其实是**中文正文**（不该进数学模式）。

    **为什么需要**：实测 MinerU 会把正文行错误地夹进 `$$...$$` 之间，例如：

        $$
        所以对任何正整数 $m$ 和 $n$ , 都有
        $$

    若照单全收包进 `\\[...\\]`，LaTeX 会报 `Display math should end with $$`
    与 `Missing $ inserted`（实测 2297 条错误多源于此）。

    判据（保守，宁可漏判也不误判）：
    - 去掉行内公式后**不含任何反斜杠命令**且含中文 → 正文；
    - 其余 → 当公式。
    """
    st = line.strip()
    if not st:
        return False
    stripped = _strip_inline_math(st).strip()
    if not stripped:
        return False                      # 全是行内公式 → 仍算公式内容
    if "\\" in stripped:
        return False                      # 含 LaTeX 命令 → 当公式
    # 去掉行内公式后仍是"中文句子" → 误入公式块的正文
    return bool(re.search(r"[\u4e00-\u9fff].*[\u4e00-\u9fff]", stripped))


def _line_has_prose_prefix(line: str) -> bool:
    """判断"正文+公式粘连"行是否以中文正文开头（需要先剥出正文）。"""
    head, tail = _split_prose_and_math(line)
    if not tail:
        return False
    head_wo_math = _strip_inline_math(head).strip()
    return bool(re.search(r"[\u4e00-\u9fff].*[\u4e00-\u9fff]", head_wo_math))


def escape_text_fragment(s: str, rep: Optional[LatexReport] = None) -> str:
    """处理"正文 + 漏网公式混排"的文本：按行拆开，公式就地包 `\\[ \\]`。

    这是段落级入口。保证返回值里 `\\[` 与 `\\]` 数量相等（不得违反）。
    """
    wrapped = _wrap_math_fragment(s, rep)
    if wrapped.count("\\[") != wrapped.count("\\]"):
        # 理论上不该发生；一旦发生，退回纯转义以保证产物可编译
        if rep:
            rep.warn("公式包装后不配对，已退回纯转义以保证可编译")
        return _escape_plain(s, rep)
    if rep:
        rep.hit("疑似公式残留（已包入 \\[ \\]）", 1)
        rep.warn(
            "检测到疑似未识别的公式片段（含 \\frac/\\begin 等），已包入 \\[ \\] 保留；"
            "请检查输入 Markdown 的 $$ 是否配对"
        )
    return wrapped


def _line_is_math(line: str) -> bool:
    """判断一行（漏网片段里的一行）是否属于**行间公式**（需要包 `\\[ \\]`）。

    关键教训（实测踩到）：一行里**已经有行内公式** `$...$` 时，绝不能把整行再包进
    `\\[ \\]`。反例：`设离散型随机变量 X 所有可能取值为 $\\{0,1,\\cdots,n\\}$`
    —— 该行含 `\\cdots` 会命中公式特征，但它的数学部分已经是行内公式，
    整行包 `\\[` 会产出"只有开没有闭"的错配（实测导致 1184 vs 1185 的失衡）。

    因此判据是：
    1. 结构行（空行 / 标题 / 引用 / 列表 / 图片）→ 不是；
    2. 去掉行内 `$...$` 后若**不再有**公式特征，且原文含中文 → 不是；
    3. 否则若仍有公式特征 → 是。
    """
    st = line.strip()
    if not st:
        return False
    if st.startswith(("#", ">", "-", "*", "+", "|", "!")):
        return False
    if st.startswith(("\\begin{", "\\end{")):
        return True

    # 把已有的行内公式挖掉，只看"剩余的裸公式内容"
    stripped = _strip_inline_math(st)
    if not _STRONG_MATH_RE.search(stripped):
        # 裸公式内容里已无公式特征 —— 该行的数学都在 $...$ 里，属正文
        return False

    # 还有裸公式特征，但要排除"中文正文里夹了一小段公式命令"的情况
    n_math_cmd = len(re.findall(r"\\[a-zA-Z]{2,}", stripped))
    n_cjk = len(re.findall(r"[\u4e00-\u9fff]", stripped))
    if n_cjk > 12 and n_math_cmd <= 1:
        return False
    return True


def _wrap_math_fragment(s: str, rep: Optional[LatexReport] = None) -> str:
    """把"公式与正文混在一起"的漏网片段拆开：公式包 `\\[ \\]`，正文照常转义。

    这是安全阀的正确实现。关键约束（都来自实测报错）：
    - `\\[...\\]` 内**不能有空行**（会报 `Display math should end with $$`）；
    - `\\[...\\]` 内**不能有 Markdown 标题**（会报 `#` 相关错误）；
    - 开闭必须**成对且就近**，否则全文 `\\[`/`\\]` 数量失衡（实测 1184 vs 1185）。

    做法：按行判定，遇到"既是正文又含裸公式"的行（MinerU 会把公式片段与正文
    粘在一行，实测如 `设…取值为 $…$，0 m + n \\mid X > m) = P (X > n).\\tag{2.10}`），
    把该行**单独**包成一段公式，保证开闭同行出现、绝不跨行泄漏。
    """
    out: List[str] = []
    buf: List[str] = []

    def flush_math() -> None:
        if not buf:
            return
        body = clean_math("\n".join(buf), rep)
        buf.clear()
        if body:
            out.append("\\[\n" + body + "\n\\]")

    for line in s.split("\n"):
        st = line.strip()
        if not st:
            flush_math()
            out.append("")
            continue
        if st.startswith(("#", ">", "-", "*", "+", "|", "!")):
            flush_math()
            out.append(_escape_plain(line, rep))
            continue
        if _line_is_math(line):
            buf.append(line)
            continue
        flush_math()
        # 该行含裸公式特征但又混着正文：整行作为一段就地闭合的公式，
        # 避免"开在这里、闭在别处"的跨行错配
        if _has_bare_math(line):
            body = clean_math(line, rep)
            out.append("\\[\n" + body + "\n\\]")
        else:
            out.append(_escape_plain(line, rep))
    flush_math()
    return "\n".join(out)


def _escape_plain(s: str, rep: Optional[LatexReport] = None) -> str:
    """不含公式特征的普通正文转义（`escape_text` 的无递归内核）。"""
    s = _map_unicode(s, rep)
    stash: List[str] = []

    def _stash(m: re.Match) -> str:
        stash.append(m.group(0))
        return f"\x00{len(stash) - 1}\x00"

    s = _PROTECT_RE.sub(_stash, s)
    for ch, esc in _TEXT_ESCAPES:
        if ch in s:
            if rep:
                rep.hit(f"转义 {ch!r}", s.count(ch))
            s = s.replace(ch, esc)
    for idx, frag in enumerate(stash):
        s = s.replace(f"\x00{idx}\x00", frag)
    return s


# 顺序敏感：反斜杠必须最先处理
_TEXT_ESCAPES: Tuple[Tuple[str, str], ...] = (
    ("\\", r"\textbackslash{}"),
    ("&", r"\&"),
    ("%", r"\%"),
    ("#", r"\#"),
    ("_", r"\_"),
    ("{", r"\{"),
    ("}", r"\}"),
    ("$", r"\$"),
    ("^", r"\textasciicircum{}"),
)

# 我们自己插入的 LaTeX 片段（如 $\Rightarrow$）不能再被转义，先占位保护
_PROTECT_RE = re.compile(r"\$\\[A-Za-z]+\$|\\[A-Za-z]+\{\}")


# 强公式特征：出现其一基本可断定这是"漏网的公式"而非正文
_STRONG_MATH_RE = re.compile(
    r"\\(?:frac|sum|int|sqrt|begin|end|alpha|beta|gamma|delta|lambda|sigma|mu|"
    r"cdot|cdots|ldots|left|right|tag|binom|overline|underline|lim|infty|"
    r"mathrm|mathbb|mathcal|operatorname|pmb|boldsymbol|exp|log|ln|sin|cos|tan|"
    r"leqslant|geqslant|neq|approx|equiv|to|rightarrow|Rightarrow|quad|qquad|"
    r"text|partial|nabla|matrix|pmatrix|bmatrix|cases|aligned|array)\b"
)


def escape_text(s: str, rep: Optional[LatexReport] = None) -> str:
    """把一段**纯正文**转义成 LaTeX 安全文本。

    流程：Unicode 映射 → 保护已生成的 LaTeX 片段 → 逐字符转义 → 还原保护片段。
    这样做的原因：`\\Rightarrow` 这类片段里含 `\\`、`{`、`}`，若不保护会被二次转义成乱码。

    **安全阀（重要）**：若一段"正文"里出现公式特征（`\\frac`、`\\begin{array}` 等），
    说明它其实是**未被识别的公式**（输入里 `$$` 不配对时必然发生）。此时：
    - 逐字符转义会毁掉公式（实测 `{` 被误转义上万次）；
    - 原样留在正文里又会报 `Missing $ inserted` / `\\tag not allowed here`
      （实测 82 处 `\\tag`、196 处 `\\begin{array}`）。
    故正确做法是**包进行间数学模式** `\\[...\\]` 输出 —— 既不转义也不裸放。
    """
    # `\~`（MinerU 用它表示范围，如 15\~18）→ 直接变 en-dash，比转义更合适
    n_range = len(re.findall(r"\\~", s))
    if n_range:
        s = re.sub(r"\\~", "--", s)
        if rep:
            rep.hit("范围符 \\~ → --", n_range)

    # 安全阀：命中**裸**公式特征（行内 $...$ 里的不算）→ 判定为漏网公式
    if _has_bare_math(s):
        return escape_text_fragment(s, rep)

    s = _map_unicode(s, rep)

    # 保护刚插入的 LaTeX 片段
    stash: List[str] = []

    def _stash(m: re.Match) -> str:
        stash.append(m.group(0))
        return f"\x00{len(stash) - 1}\x00"

    s = _PROTECT_RE.sub(_stash, s)

    for ch, esc in _TEXT_ESCAPES:
        if ch in s:
            if rep:
                rep.hit(f"转义 {ch!r}", s.count(ch))
            s = s.replace(ch, esc)

    # 还原
    for idx, frag in enumerate(stash):
        s = s.replace(f"\x00{idx}\x00", frag)
    return s
_DISPLAY_RE = re.compile(r"\$\$(.+?)\$\$", re.S)
_INLINE_RE = re.compile(r"(?<!\$)\$(?!\$)([^$\n]+?)(?<!\$)\$(?!\$)")


def split_segments(text: str) -> List[Tuple[str, str]]:
    """把文本切成 `[('text'|'display'|'inline', 内容), ...]`。

    这是本模块正确性的地基：只有先分清数学区和正文区，才能对各自用对的规则。

    **健壮性**：真实 MinerU 输出里 `$$` 个数可能是**奇数**（实测某书 1393 个，
    有一处未闭合/多余）。若不加处理，任何"按对匹配"的解析都会从这里开始错位，
    把后面成千上万条公式当成正文转义（实测 `{` 被误转义 11444 次）。
    故本函数只用**能成对**的 `$$`，落单的那个原样留在正文里，由调用方报告。
    """
    segs: List[Tuple[str, str]] = []
    pos = 0
    for m in _DISPLAY_RE.finditer(text):
        if m.start() > pos:
            segs.append(("text", text[pos:m.start()]))
        segs.append(("display", m.group(1)))
        pos = m.end()
    if pos < len(text):
        segs.append(("text", text[pos:]))

    # 再对 text 段切行内公式
    out: List[Tuple[str, str]] = []
    for kind, chunk in segs:
        if kind != "text":
            out.append((kind, chunk))
            continue
        p = 0
        for m in _INLINE_RE.finditer(chunk):
            if m.start() > p:
                out.append(("text", chunk[p:m.start()]))
            out.append(("inline", m.group(1)))
            p = m.end()
        if p < len(chunk):
            out.append(("text", chunk[p:]))
    return out


def normalize_display_delims(md: str, rep: Optional[LatexReport] = None) -> str:
    """把落单的 `$$` 定界符中和掉，保证 `$$` 成对。

    **为什么必须做**：实测某本 MinerU 输出有 **1393 个 `$$`（奇数）**。
    只要有一个落单，任何"按对匹配"的解析都会从那里开始错位：
    一段正文被当成公式、一段公式被当正文，进而引发
    `Display math should end with $$` / `Missing $ inserted` 等一连串报错，
    并且产出的 `\\[` 与 `\\]` 数量不相等（实测 1184 vs 1185）。

    做法：按出现顺序两两配对；凡是能与前一个配上的就保留，
    最后落单的那一个替换成普通文本 `\$\$`（转义成字面量），从而恢复配对。
    这是**保守**处理：只动定界符，不动任何公式内容。
    """
    positions = [m.start() for m in re.finditer(r"\$\$", md)]
    if len(positions) % 2 == 0:
        return md
    # 落单的是最后一个（前面已两两配对）
    last = positions[-1]
    if rep:
        rep.hit("中和落单的 $$", 1)
        rep.warn(
            f"输入中 $$ 定界符共 {len(positions)} 个（奇数），"
            f"已把最后一个（字符位置 {last}）中和为字面量以恢复配对"
        )
    return md[:last] + r"\$\$" + md[last + 2:]


def check_math_balance(md: str) -> List[str]:
    """检查数学定界符是否配对，返回告警列表（空 = 正常）。

    单独抽出来是因为"输入损坏"与"转换逻辑"必须能分开定位：
    实测某 MinerU 输出有奇数个 `$$`，若不先报出来，使用者只会看到
    满屏莫名其妙的转义统计而不知根因。
    """
    warns: List[str] = []
    n_display = md.count("$$")
    if n_display % 2:
        warns.append(
            f"行间公式定界符 $$ 共 {n_display} 个（奇数），存在未闭合/多余的 $$；"
            "该处及其后续可能被当作正文，建议回查原始 Markdown"
        )
    # 逐行检查行内 $
    bad_lines = []
    for i, ln in enumerate(md.split("\n"), start=1):
        if ln.strip() == "$$":
            continue
        if len(re.findall(r"(?<!\$)\$(?!\$)", ln)) % 2:
            bad_lines.append(i)
    if bad_lines:
        head = ", ".join(str(x) for x in bad_lines[:8])
        more = f" 等 {len(bad_lines)} 行" if len(bad_lines) > 8 else ""
        warns.append(f"以下行内公式 $ 不配对（第 {head} 行{more}）")
    return warns


# --------------------------------------------------------------------------
# 公式清理：只做"结构性"整理，绝不改动数学内容
# --------------------------------------------------------------------------
# 数学字体没有中文字形（实测 \mathrm{拍} 会 Missing character），
# 但 \text{} 走的是正文字体（ctex 已配好）→ 把 \mathrm/\mathbf 里的纯中文改投 \text。
_MATH_FONT_WITH_CJK_RE = re.compile(
    r"\\(mathrm|mathbf|mathit|mathsf|mathtt)\s*\{\s*([^{}]*[\u4e00-\u9fff][^{}]*)\}"
)

# 公式里"裸露的中文连续段"。数学字体没有 CJK 字形，实测会报
# `Missing character: There is no 第 (U+7B2C) ...`，故必须包进 \text{}。
# 例：$B_{n}=\{第n次投掷后不再出现1点\}$ → $B_{n}=\{\text{第}n\text{次投掷后不再出现}1\text{点}\}$
_BARE_CJK_IN_MATH_RE = re.compile(r"[\u4e00-\u9fff]+")


def _protect_bare_cjk_in_math(eq: str, rep: Optional[LatexReport] = None) -> str:
    """把公式里裸露的中文包进 `\\text{}`，避免 CJK 用数学字体渲染成空框。

    只在 `\\text{}` **之外**替换，且以"连续中文段"为单位，
    这样 `第n次` 会变成 `\\text{第}n\\text{次}`，既保住中文又保住变量 n 的斜体。
    """
    # 先把已有的 \text{...} 挖出来保护，避免二次包裹
    stash: List[str] = []

    def _stash(m: re.Match) -> str:
        stash.append(m.group(0))
        return f"\x01{len(stash) - 1}\x01"

    eq = re.sub(r"\\text\s*\{[^{}]*\}", _stash, eq)

    n = len(_BARE_CJK_IN_MATH_RE.findall(eq))
    if n:
        eq = _BARE_CJK_IN_MATH_RE.sub(lambda m: "\\text{" + m.group(0) + "}", eq)
        if rep:
            rep.hit("公式内裸中文 → \\text{}", n)
            rep.warn("公式内有裸露中文，已自动包入 \\text{}（否则该字在 PDF 中显示为空）")

    for idx, frag in enumerate(stash):
        eq = eq.replace(f"\x01{idx}\x01", frag)
    return eq


def _rescue_cjk_in_math(eq: str, rep: Optional[LatexReport] = None) -> str:
    """把 `\\mathrm{拍}` 这类"中文字在数学字体里"的写法改成 `\\text{拍}`。

    依据：实测 \mathrm{拍} 触发 `Missing character: There is no 拍 ... in font
    lmroman...`，而 \text{拍} 正常渲染（\text 用正文字体）。
    仅当花括号内**含中文**时才改写，纯西文 `\mathrm{d}` 一律不动。
    """
    def repl(m: re.Match) -> str:
        cmd, inner = m.group(1), m.group(2)
        # 去掉内层 \text{}，统一交给外层 \text
        inner = re.sub(r"\\text\s*\{\s*([^}]*?)\s*\}", r"\1", inner).strip()
        if rep:
            rep.hit("公式内中文 \\mathrm→\\text", 1)
        # 混排（有中文也有西文下标符号）时用 \text 保底即可
        return "\\text{" + inner + "}"

    return _MATH_FONT_WITH_CJK_RE.sub(repl, eq)


def _fix_math_symbols(eq: str, rep: Optional[LatexReport] = None) -> str:
    """修掉公式里 Latin Modern 没有字形的零星符号（实测 3 类）。

    - `♡` / `ⓞ` 等装饰符与带圈字母：数学字体无字形 → 换成等价 LaTeX / ASCII；
    - 这些字符出现在**公式内部**时不会被正文的 `_map_unicode` 覆盖，故单独处理。

    **注意**：`\\tag{...}` 的参数是**文本**而非数学模式，往里塞 `\\heartsuit{}`
    会报 `Missing $ inserted` / `Extra }`（实测踩到：MinerU 用 `♡` 当公式编号
    占位符，产出 `\\tag{♡}`）。故先单独把 `\\tag{}` 里的符号转成纯文本。
    """
    # 1) 先处理 \tag{...} 内部：只允许纯文本，符号一律降级
    def _fix_tag(m: re.Match) -> str:
        inner = m.group(1)
        for ch, tex in (("♡", "*"), ("♢", "*"), ("♣", "*"), ("♠", "*")):
            if ch in inner:
                if rep:
                    rep.hit(f"公式内符号 {ch!r} 替换", inner.count(ch))
                inner = inner.replace(ch, tex)
        inner = re.sub(r"[\u2460-\u2473\u24DE\u24D0-\u24D3]", "", inner)
        return "\\tag{" + inner.strip() + "}"

    eq = re.sub(r"\\tag\s*\{([^{}]*)\}", _fix_tag, eq)

    # 2) 再处理公式体内部（此时残留的都不在 \tag 里了）
    repl = {
        "♡": r"\heartsuit{}", "♢": r"\diamondsuit{}", "♣": r"\clubsuit{}",
        "♠": r"\spadesuit{}",
        "ⓞ": "(o)", "ⓐ": "(a)", "ⓑ": "(b)", "ⓒ": "(c)", "ⓓ": "(d)",
        "①": "(1)", "②": "(2)", "③": "(3)", "④": "(4)", "⑤": "(5)",
        "⑥": "(6)", "⑦": "(7)", "⑧": "(8)", "⑨": "(9)", "⑩": "(10)",
    }
    for ch, tex in repl.items():
        if ch in eq:
            if rep:
                rep.hit(f"公式内符号 {ch!r} 替换", eq.count(ch))
            eq = eq.replace(ch, tex)
    return eq


def clean_math(eq: str, rep: Optional[LatexReport] = None) -> str:
    """整理一段公式：`\\text { 中文 }` → `\\text{中文}`，压缩多余空白。"""
    n = len(re.findall(r"\\text\s*\{", eq))
    if n:
        eq = re.sub(r"\\text\s*\{\s*([^}]*?)\s*\}", r"\\text{\1}", eq)
        if rep:
            rep.hit("\\text{} 空格整理", n)
    eq = _rescue_cjk_in_math(eq, rep)
    eq = _protect_bare_cjk_in_math(eq, rep)
    eq = _fix_math_symbols(eq, rep)
    # 公式内的连续空格压成一个（换行保留：array/aligned 依赖 \\ 换行）
    eq = re.sub(r"[ \t]{2,}", " ", eq)
    return eq.strip()


# --------------------------------------------------------------------------
# 表格：<table> → tabularx
# --------------------------------------------------------------------------
def _convert_table(html: str, rep: LatexReport, colspec: str = "|X|X|") -> str:
    """把 MinerU 产出的 HTML 表格转成 LaTeX 表格环境。

    MinerU 的表格是规整的 `<tr><td>..</td></tr>`，无 rowspan/colspan，
    因此可安全地按行列重组。
    """
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", html, re.S | re.I)
    if not rows:
        rep.warn("发现无 <tr> 的表格，已跳过")
        return ""
    body: List[str] = []
    ncol = 0
    for r in rows:
        cells = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", r, re.S | re.I)
        ncol = max(ncol, len(cells))
        cells = [_cell_to_latex(c, rep) for c in cells]
        body.append(" & ".join(cells) + r" \\ \hline")
    if ncol == 0:
        rep.warn("表格无单元格，已跳过")
        return ""

    spec = "|" + "|".join(["X"] * ncol) + "|"
    rep.hit("HTML 表格 → tabularx", 1)
    return (
        "\n\\begin{table}[htbp]\n\\centering\n"
        f"\\begin{{tabularx}}{{\\linewidth}}{{{spec}}}\n\\hline\n"
        + "\n".join(body)
        + "\n\\end{tabularx}\n\\end{table}\n"
    )


def _cell_to_latex(cell: str, rep: LatexReport) -> str:
    """单元格内容：内部可能有行内公式，需按区段分别处理。"""
    cell = re.sub(r"<[^>]+>", "", cell).strip()
    parts = []
    for kind, chunk in split_segments(cell):
        if kind == "text":
            parts.append(escape_text(chunk, rep))
        elif kind == "inline":
            parts.append("$" + clean_math(chunk, rep) + "$")
        else:
            parts.append("\\[" + clean_math(chunk, rep) + "\\]")
    return "".join(parts).replace("\n", " ").strip()


# --------------------------------------------------------------------------
# 图片
# --------------------------------------------------------------------------
_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")

# HTML 包装标签：MinerU 会输出 <div class="mineru-algorithm">…</div>。
# 本模块**不假设**已跑过 clean_markdown.py，故自带一层兜底剥离，
# 否则这些标签会被当正文转义后原样排进 PDF（实测会泄漏到成品里）。
#
# 注意（踩过的坑）：这里**不放 `p`**。实测正文有 "…分布律为 <p<1，如果…"
# 这类数学残句，`<p<1` 会被误认成 `<p ...>` 开标签，`[^>]*>` 一路吞到远处，
# 一次删掉 21 个 `$$`，使 display math 配对失衡。且要求标签名后紧跟空白/`>`/`/`。
_WRAPPER_RE = re.compile(
    r"</?(?:div|span|section|article|details|summary)(?=[\s/>])[^>]*>",
    re.IGNORECASE,
)


def _convert_image(path: str, rep: LatexReport, base_dir: Optional[Path]) -> str:
    """图片引用 → \\includegraphics，并校验文件是否真的存在。"""
    rel = path.strip()
    if base_dir is not None:
        if not (base_dir / rel).is_file():
            rep.warn(f"图片缺失（已保留 \\includegraphics 占位）: {rel}")
            rep.hit("图片缺失", 1)
        else:
            rep.hit("图片 → includegraphics", 1)
    else:
        rep.hit("图片 → includegraphics", 1)
    # 统一正斜杠，LaTeX 在 Windows 下也认
    return f"\\begin{{center}}\n\\includegraphics[width=\\linewidth]{{\\detokenize{{{rel}}}}}\n\\end{{center}}\n"


# --------------------------------------------------------------------------
# 标题
# --------------------------------------------------------------------------
_HEADING_MAP_DEFAULT = {
    1: "chapter",
    2: "section",
    3: "subsection",
    4: "subsubsection",
    5: "paragraph",
    6: "subparagraph",
}


def _convert_heading(level: int, body: str, rep: LatexReport, hmap: Dict[int, str]) -> str:
    cmd = hmap.get(level, "subparagraph")
    parts = []
    for kind, chunk in split_segments(body):
        if kind == "text":
            parts.append(escape_text(chunk, rep))
        elif kind == "inline":
            parts.append("$" + clean_math(chunk, rep) + "$")
        else:
            parts.append("\\[" + clean_math(chunk, rep) + "\\]")
    title = "".join(parts).strip()
    rep.hit(f"标题 → \\{cmd}", 1)
    return f"\n\\{cmd}{{{title}}}\n"


# --------------------------------------------------------------------------
# 主转换
# --------------------------------------------------------------------------
_PREAMBLE = r"""% !TEX program = xelatex
% 由 MinerU/md2latex.py 生成。建议用 XeLaTeX 编译（中文 + 字体）。
\documentclass[UTF8]{__DOCCLASS__}

\usepackage{ctex}          % 中文支持（XeLaTeX）
\usepackage{amsmath,amssymb}% 数学
\usepackage{graphicx}      % \includegraphics
\usepackage{tabularx}      % 表格
\usepackage{booktabs}
\usepackage[table]{xcolor}
\usepackage{geometry}
\geometry{a4paper,left=2.5cm,right=2.5cm,top=2.2cm,bottom=2.2cm}
\usepackage{hyperref}
\hypersetup{colorlinks=true,linkcolor=blue,urlcolor=blue}

% MinerU 常把长公式放窄页里，允许轻微超出而不报 Overfull 警告刷屏
\setlength{\emergencystretch}{2em}

\begin{document}
__TOC__
"""

_POSTAMBLE = "\n\\end{document}\n"


def markdown_to_latex(
    md: str,
    *,
    base_dir: Optional[Path] = None,
    doc_class: str = "ctexbook",
    toc: bool = False,
    heading_map: Optional[Dict[int, str]] = None,
    standalone: bool = True,
    report: Optional[LatexReport] = None,
) -> Tuple[str, LatexReport]:
    """把 MinerU Markdown 转成 LaTeX 源码，返回 (tex, 报告)。纯函数。"""
    rep = report or LatexReport()
    hmap = dict(_HEADING_MAP_DEFAULT)
    if heading_map:
        hmap.update(heading_map)

    # 兜底：剥掉 HTML 包装标签（正文里的 <div> 等），保留其内容
    n_wrap = len(_WRAPPER_RE.findall(md))
    if n_wrap:
        md = _WRAPPER_RE.sub("", md)
        rep.hit("去 HTML 包装标签（兜底）", n_wrap)
    # HTML 实体兜底（&gt; 等会破坏 LaTeX 输出）
    if re.search(r"&(?:gt|lt|amp|quot|nbsp|#\d+);", md):
        import html as _html
        n_ent = len(re.findall(r"&(?:gt|lt|amp|quot|nbsp|#\d+);", md))
        md = _html.unescape(md.replace("&nbsp;", " "))
        rep.hit("HTML 实体反转义（兜底）", n_ent)

    # 先体检：数学定界符不配对会引发大面积误转义，必须让使用者知道根因
    for w in check_math_balance(md):
        rep.warn(w)
    # 再中和落单的 $$，保证后续按对匹配不会错位
    md = normalize_display_delims(md, rep)

    out: List[str] = []
    if standalone:
        # 用占位符替换而非 %-格式化：导言区里有大量 LaTeX 注释 %，会与格式化冲突
        out.append(
            _PREAMBLE
            .replace("__DOCCLASS__", doc_class)
            .replace("__TOC__", "\\tableofcontents\n\\clearpage\n" if toc else "")
        )

    lines = md.split("\n")
    i = 0
    para: List[str] = []          # 累积普通段落行

    def flush_para() -> None:
        """把累积的段落行转成 LaTeX 段落（行内公式按区段处理）。

        注意：这里**不调用** `escape_text` 的安全阀分支。原因是段落是"拼接"出来的
        （见下方 `"".join(parts)`），若某个 chunk 返回以 `\\[` 开头的文本，就会和
        前面的正文粘成一行，而配对的 `\\]` 落在后面 —— 实测正是这样产出
        `…$\\{0,1,\\cdots,n\\}$\\[` 这种非法行，并使全文 `\\[`/`\\]` 失衡（1184 vs 1185）。
        漏网公式的处理统一交给 `escape_text_fragment()`：它按行处理并保证就地闭合。
        """
        if not para:
            return
        text = "\n".join(para).strip()
        para.clear()
        if not text:
            return
        # 若整段里含裸公式（漏网公式），交给按行处理的 fragment 版本，保证开闭成对
        if _has_bare_math(text):
            piece = escape_text_fragment(text, rep).strip()
            if piece:
                out.append(piece + "\n")
                rep.hit("段落", 1)
            return
        parts = []
        for kind, chunk in split_segments(text):
            if kind == "text":
                parts.append(_escape_plain(chunk, rep))
            elif kind == "inline":
                parts.append("$" + clean_math(chunk, rep) + "$")
            else:
                parts.append("\\[\n" + clean_math(chunk, rep) + "\n\\]")
        piece = "".join(parts).strip()
        if piece:
            out.append(piece + "\n")
            rep.hit("段落", 1)

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()

        # --- 空行：段落边界 ---
        if not s:
            flush_para()
            i += 1
            continue

        # --- 行间公式块：$$ ... $$（可能跨多行）---
        if s == "$$":
            flush_para()
            j = i + 1
            buf: List[str] = []
            while j < len(lines) and lines[j].strip() != "$$":
                buf.append(lines[j])
                j += 1
            if j >= len(lines):
                rep.warn(f"第 {i + 1} 行起有未闭合的 $$ 块，已按段落处理")
                para.append(ln)
                i += 1
                continue
            # MinerU 有时会把中文正文行夹进 $$ 块里（实测）。这些行不能进数学模式，
            # 否则报 `Display math should end with $$` / `Missing $ inserted`。
            # 这里把块内内容拆成"公式片段"与"正文片段"，各自输出。
            math_buf: List[str] = []

            def flush_block_math() -> None:
                if not math_buf:
                    return
                body = clean_math("\n".join(math_buf), rep)
                math_buf.clear()
                if body:
                    out.append("\\[\n" + body + "\n\\]\n")
                    rep.hit("行间公式 → \\[ \\]", 1)

            for bl in buf:
                if bl.strip() and _line_is_prose(bl):
                    flush_block_math()
                    rep.hit("$$ 块内正文（已剥离）", 1)
                    prose = _escape_plain(bl.strip(), rep)
                    if prose.strip():
                        out.append(prose + "\n")
                elif bl.strip() and _line_has_prose_prefix(bl):
                    # 正文 + 公式残片粘在同一行：拆开后分别输出
                    flush_block_math()
                    head, tail = _split_prose_and_math(bl)
                    rep.hit("$$ 块内正文+公式粘连（已拆分）", 1)
                    prose = _escape_plain(head.strip(), rep)
                    if prose.strip():
                        out.append(prose + "\n")
                    body = clean_math(tail.strip(), rep)
                    if body:
                        out.append("\\[\n" + body + "\n\\]\n")
                        rep.hit("行间公式 → \\[ \\]", 1)
                else:
                    math_buf.append(bl)
            flush_block_math()
            i = j + 1
            continue

        # 单行 $$...$$ 形式
        m = re.match(r"^\$\$(.+?)\$\$$", s)
        if m:
            flush_para()
            eq = clean_math(m.group(1), rep)
            if eq:
                out.append("\\[\n" + eq + "\n\\]\n")
                rep.hit("行间公式 → \\[ \\]", 1)
            i += 1
            continue

        # --- 标题 ---
        m = re.match(r"^(#{1,6})\s*(.+?)\s*$", s)
        if m:
            flush_para()
            out.append(_convert_heading(len(m.group(1)), m.group(2), rep, hmap))
            i += 1
            continue

        # --- HTML 表格（可能跨行）---
        if re.match(r"^<table\b", s, re.I):
            flush_para()
            buf = []
            while i < len(lines):
                buf.append(lines[i])
                if re.search(r"</table>", lines[i], re.I):
                    i += 1
                    break
                i += 1
            tex = _convert_table("\n".join(buf), rep)
            if tex:
                out.append(tex)
            continue

        # --- 图片（独占一行时单独成段）---
        if _IMG_RE.fullmatch(s):
            flush_para()
            path = _IMG_RE.fullmatch(s).group(1)
            out.append(_convert_image(path, rep, base_dir))
            i += 1
            continue

        # --- 引用块 → quote ---
        if s.startswith(">"):
            flush_para()
            body = s.lstrip(">").strip()
            parts = []
            for kind, chunk in split_segments(body):
                parts.append(escape_text(chunk, rep) if kind == "text"
                             else "$" + clean_math(chunk, rep) + "$")
            out.append("\\begin{quote}\n" + "".join(parts) + "\n\\end{quote}\n")
            rep.hit("引用块", 1)
            i += 1
            continue

        # --- 其余：并入段落 ---
        para.append(ln)
        i += 1

    flush_para()

    if standalone:
        out.append(_POSTAMBLE)

    tex = "\n".join(x for x in out if x is not None)
    tex = re.sub(r"\n{3,}", "\n\n", tex)
    return tex, rep


def convert_file(
    src: Path,
    dst: Optional[Path] = None,
    *,
    report_only: bool = False,
    **kwargs,
) -> LatexReport:
    """转换单个文件；`report_only=True` 时不写文件。"""
    md = src.read_text(encoding="utf-8", errors="replace")
    tex, rep = markdown_to_latex(md, base_dir=src.parent, **kwargs)
    if not report_only and dst is not None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(tex, encoding="utf-8")
    return rep


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="md2latex.py",
        description="MinerU Markdown → LaTeX（XeLaTeX）：标题/公式/表格/图片 + 正确转义。",
    )
    ap.add_argument("input", help="输入 .md 文件或目录")
    ap.add_argument("-o", "--output", default=None, help="输出 .tex 文件或输出目录")
    ap.add_argument("--doc-class", default="ctexbook", help="文档类，默认 ctexbook（可用 ctexart）")
    ap.add_argument("--toc", action="store_true", help="在开头插入 \\tableofcontents")
    ap.add_argument("--fragment", action="store_true", help="只输出正文片段，不带导言区")
    ap.add_argument("--report", action="store_true", help="只报告统计，不写文件")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args(argv)

    inp = Path(args.input)
    if inp.is_file():
        sources = [inp]
    elif inp.is_dir():
        sources = sorted(inp.rglob("*.md"))
    else:
        print(f"错误: 路径不存在: {inp}", file=sys.stderr)
        return 1
    if not sources:
        print("没有找到 .md 文件", file=sys.stderr)
        return 1

    out_root = Path(args.output) if args.output else None
    total = Counter()
    warned = 0
    for src in sources:
        if args.report:
            dst = None
        elif out_root is None:
            dst = src.with_suffix(".tex")
        elif out_root.is_dir() or len(sources) > 1:
            dst = out_root / (src.stem + ".tex")
        else:
            dst = out_root

        rep = convert_file(
            src, dst,
            report_only=args.report,
            doc_class=args.doc_class,
            toc=args.toc,
            standalone=not args.fragment,
        )
        total.update(rep.counts)
        warned += len(rep.warnings)
        if not args.quiet:
            print(f"\n[{'报告' if args.report else dst}] {src}")
            print(rep)

    print(f"\n共处理 {len(sources)} 个文件")
    if total:
        width = max(len(k) for k in total)
        print("\n".join(f"  {k:<{width}}  {v}" for k, v in sorted(total.items())))
    if warned:
        print(f"\n注意: 共 {warned} 条警告（多为图片缺失，不影响编译）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
