#!/usr/bin/env python3
"""把 Actions 生成在 `out/` 里的 PDF 发布到站点目录 `pdfs/`，并维护索引。

为什么单独成脚本，而不写在 workflow 的 bash 里：
  要把「读已有 index.json → 合并 → 去重 → 按 id 倒序 → 只留最近 30 组 →
  删掉被淘汰的 PDF」这套逻辑用 bash + jq 写清楚非常费劲，也没法在本地复现。
  抽成 Python 后，同一个脚本本地能跑（造假 PDF 测命名/索引/淘汰），
  workflow 里只需要一行 `python3 .github/scripts/publish_pdfs.py`。

命名规则：
  站内文件名 = `<run_number 补零 3 位>-<原文件名>`，
  例如 `pdfs/003-示例·三题·题卷.pdf`。
  前面加 run 号是为了「同一标题在不同 run 里不会互相覆盖」——
  否则第二次出一份同名卷子会把上一次的文件悄悄改掉。

索引结构（pdfs/index.json）：
  {
    "generated": "2026-11-05T10:36:00Z",
    "items": [
      {"id": "003", "title": "示例·三题",
       "files": [{"kind": "题卷", "name": "003-示例·三题·题卷.pdf",
                  "size": 63488, "pages": 2}, …],
       "created": "2026-11-05T10:36:00Z",
       "run": "https://github.com/<owner>/<repo>/actions/runs/<run_id>"}
    ]
  }
  items 按 id 倒序（新的在前）；`pages` 取不到时为 null。

用法（本地模拟时同样跑这一条，只是路径换成假的 out/）：
  python3 .github/scripts/publish_pdfs.py \
      --out out --dest pdfs \
      --run-number 3 --run-id 1234567890 \
      --repo wasio-official/wasio-official.github.io --keep 30
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# 一份卷子里文件的固定顺序：题卷在前，答案卷在后
KIND_ORDER = ("题卷", "答案卷")

# 文件名形如 `示例·三题·题卷.pdf`；标题自己可能带「·」，所以用贪婪匹配
NAME_RE = re.compile(r"^(?P<title>.+)·(?P<kind>题卷|答案卷)$")

# 只清理「本站生成的」PDF：000-xxx.pdf 这种带 run 号前缀的，别的手工文件不动
GENERATED_RE = re.compile(r"^\d{3,}-.+\.pdf$")


def log(msg: str = "") -> None:
    print(msg, flush=True)


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.2f} MB"
    return f"{n / 1024:.0f} KB"


def split_name(stem: str) -> tuple[str, str]:
    """`示例·三题·题卷` → (`示例·三题`, `题卷`)；认不出后缀时 kind 记为 `PDF`。"""
    m = NAME_RE.match(stem)
    if m:
        return m.group("title"), m.group("kind")
    if "答案" in stem:
        return stem, "答案卷"
    if "题卷" in stem:
        return stem, "题卷"
    return stem, "PDF"


def pdf_pages(path: Path) -> int | None:
    """用 pdfinfo 取页数；取不到就返回 None（索引里记 null，页面不显示页数）。

    先把文件复制成临时目录里的 ASCII 名再问 pdfinfo —— 中文文件名在
    Windows 的 pdfinfo（poppler）下常因控制台编码打不开，直接传中文路径
    会静默失败。复制成本可忽略（几十 KB）。
    """
    exe = shutil.which("pdfinfo")
    if not exe:
        return None
    try:
        with tempfile.TemporaryDirectory() as tmp:
            probe = Path(tmp) / "probe.pdf"
            shutil.copyfile(path, probe)
            proc = subprocess.run(
                [exe, str(probe)],
                capture_output=True,
                timeout=60,
            )
        # 不传 text=True：Windows 上 pdfinfo 的告警按本地代码页（GBK）输出，
        # 用 UTF-8 硬解会直接抛 UnicodeDecodeError；这里只要 ASCII 的 "Pages:"。
        out = proc.stdout.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 —— 页数只是锦上添花，不能因此中断发布
        return None
    for line in out.splitlines():
        if line.startswith("Pages:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None


def load_index(path: Path) -> tuple[list[dict], bool]:
    """读取已有索引，返回 (items, 是否读成功)。

    读失败时**不清洗 pdfs/**（见 main 里的 prune 条件）：索引坏了还去删文件，
    会把历史卷子一起弄丢；宁可保留孤儿文件，等下一次正常运行时再清。
    """
    if not path.exists():
        return [], True
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        log(f"  ! 现有 {path} 解析失败（{exc}），按空索引重建，且本次不清理旧 PDF")
        return [], False
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list):
        log(f"  ! 现有 {path} 结构不认识（items 不是数组），按空索引重建，且本次不清理旧 PDF")
        return [], False
    return [it for it in items if isinstance(it, dict)], True


def id_key(item: dict) -> tuple[int, str, str]:
    """倒序排序用：先按 id 数字，再按创建时间，最后按标题（稳定、可比）。"""
    raw = str(item.get("id", ""))
    try:
        num = int(raw)
    except ValueError:
        num = -1
    return num, str(item.get("created") or ""), str(item.get("title") or "")


def collect_from_out(out_dir: Path) -> dict[str, dict]:
    """扫描 out/**/*.pdf，按「标题」归组（题卷 + 答案卷合成一组）。

    同一标题下出现同名文件（两个 paperset 撞了标题）时，按路径序后者胜出，
    与「后写覆盖」的直觉一致。
    """
    groups: dict[str, dict] = {}
    for p in sorted(out_dir.rglob("*.pdf")):
        if not p.is_file():
            continue
        title, kind = split_name(p.stem)
        g = groups.setdefault(title, {"title": title, "files": {}})
        g["files"][p.name] = (kind, p)

    for g in groups.values():
        ordered = sorted(
            g["files"].values(),
            key=lambda kp: (
                KIND_ORDER.index(kp[0]) if kp[0] in KIND_ORDER else len(KIND_ORDER),
                kp[1].name,
            ),
        )
        g["files"] = ordered
    return groups


def build_items(
    groups: dict[str, dict],
    dest: Path,
    rid: str,
    created: str,
    run_url: str,
) -> list[dict]:
    items: list[dict] = []
    for title in sorted(groups):
        g = groups[title]
        files: list[dict] = []
        for kind, src in g["files"]:
            name = f"{rid}-{src.name}"
            target = dest / name
            shutil.copyfile(src, target)
            size = target.stat().st_size
            pages = pdf_pages(target)
            files.append({"kind": kind, "name": name, "size": size, "pages": pages})
            pages_txt = f"{pages} 页" if pages is not None else "页数未知"
            log(f"  + {name}  ({human_size(size)}, {pages_txt})")
        items.append({
            "id": rid,
            "title": title,
            "files": files,
            "created": created,
            "run": run_url,
        })
    return items


def prune_files(dest: Path, items: list[dict]) -> list[str]:
    """删掉索引里已不存在的本站 PDF（被淘汰 / 被同 run 的新结果顶掉的）。"""
    referenced = {
        str(f.get("name"))
        for it in items
        for f in (it.get("files") or [])
        if isinstance(f, dict) and f.get("name")
    }
    removed: list[str] = []
    for p in sorted(dest.glob("*.pdf")):
        if not GENERATED_RE.match(p.name):
            continue
        if p.name in referenced:
            continue
        try:
            p.unlink()
            removed.append(p.name)
        except OSError as exc:
            log(f"  ! 删不掉 {p.name}（{exc}），索引已移除，文件留着无害")
    return removed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把 out/ 的 PDF 发布到站点 pdfs/ 并维护 index.json")
    ap.add_argument("--out", default="out", help="PDF 输出目录（默认 out）")
    ap.add_argument("--dest", default="pdfs", help="站点发布目录（默认 pdfs）")
    ap.add_argument("--run-number", required=True, type=int, help="Actions 的 run_number")
    ap.add_argument("--run-id", default="", help="Actions 的 run_id（拼运行链接；本地可省）")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""),
                    help="owner/repo（拼运行链接；默认取 $GITHUB_REPOSITORY）")
    ap.add_argument("--keep", type=int, default=30, help="只保留最近多少组（默认 30）")
    ap.add_argument("--now", default="", help="覆盖时间戳（ISO8601，测试用）")
    ap.add_argument("--commit-msg-file", default="",
                    help="把建议的 git commit message 写到这个文件（workflow 用它提交）")
    args = ap.parse_args(argv)

    out_dir = Path(args.out)
    dest = Path(args.dest)
    rid = f"{args.run_number:03d}"
    created = args.now or now_utc()

    if not out_dir.is_dir():
        log(f"::warning::没有 {out_dir}/ 目录 —— 本次没有可发布的 PDF")
        return 0

    groups = collect_from_out(out_dir)
    if not groups:
        log(f"::warning::{out_dir}/ 里没有 PDF —— 本次没有可发布的 PDF（artifact 仍然可用）")
        return 0

    dest.mkdir(parents=True, exist_ok=True)
    index_path = dest / "index.json"
    old_items, index_ok = load_index(index_path)

    if args.repo and args.run_id:
        run_url = f"https://github.com/{args.repo}/actions/runs/{args.run_id}"
    elif args.repo:
        run_url = f"https://github.com/{args.repo}/actions"
    else:
        run_url = ""

    log(f"发布 run {rid}：{len(groups)} 组 / 共 "
        f"{sum(len(g['files']) for g in groups.values())} 个 PDF → {dest}/")
    new_items = build_items(groups, dest, rid, created, run_url)

    # 去重：同一 (id, 标题) 视为同一次出卷的结果，用新的顶掉旧的；
    # 文件名撞上（例如重跑时 mode 变了、文件少了一份）也一并顶掉，避免幽灵条目。
    new_keys = {(it["id"], it["title"]) for it in new_items}
    new_names = {f["name"] for it in new_items for f in it["files"]}
    kept: list[dict] = []
    for it in old_items:
        if (str(it.get("id")), str(it.get("title"))) in new_keys:
            continue
        names = {str(f.get("name")) for f in (it.get("files") or []) if isinstance(f, dict)}
        if names & new_names:
            continue
        kept.append(it)

    items = new_items + kept
    items.sort(key=id_key, reverse=True)

    # 保留最近 N 组：id 越大越新，所以直接截断尾部
    dropped = items[args.keep:] if args.keep > 0 else []
    items = items[: args.keep] if args.keep > 0 else items

    if index_ok:
        removed = prune_files(dest, items)
    else:
        removed = []
        log("  ! 索引读取失败，本次不删旧 PDF（只写新索引）")

    payload = {"generated": created, "items": items}
    index_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    log("")
    log(f"索引：共 {len(items)} 组（保留上限 {args.keep}）"
        + (f"，淘汰 {len(dropped)} 组：" + "、".join(f"#{it.get('id')} {it.get('title')}" for it in dropped)
           if dropped else ""))
    if removed:
        log(f"已删除文件 {len(removed)} 个：" + "、".join(removed))
    log(f"index.json：{index_path}（{human_size(index_path.stat().st_size)}）")

    if args.commit_msg_file:
        titles = [it["title"] for it in new_items]
        if len(titles) == 1:
            msg = f"pdf: 出卷 {rid}（{titles[0]}）"
        else:
            msg = f"pdf: 出卷 {rid}（{titles[0]} 等 {len(titles)} 组）"
        Path(args.commit_msg_file).write_text(msg, encoding="utf-8")
        log(f"commit message：{msg}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
