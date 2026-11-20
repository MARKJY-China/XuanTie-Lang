#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""玄铁性能对比图生成器。

读取 bench/results/*.json，为每个基准用例生成一张「对数刻度横向条形图 + 数据明细表」
PNG，并生成一个 index.html 画廊。版式对齐 issue #168 的 FFT 对比图：最快在顶部、
玄铁高亮、右侧标数值、下方表格给出总耗时/单次/相对玄铁/样本数。

用法（仓库根目录）：
  python bench/chart.py                         # 用最新 measured 快照，生成全部用例
  python bench/chart.py --results bench/results/2026-10-06-浮点raw化.json
  python bench/chart.py --only 浮点累加          # 只生成名字含该子串的用例
  python bench/chart.py --out bench/charts      # 输出目录

依赖：Pillow（仅绘图需要；bench/run.py 本身仍只用标准库）。
中文字体优先找 Windows 的微软雅黑/黑体，其次 Linux/macOS 常见 CJK 字体。
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少 Pillow：pip install pillow\n")
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
RESULTS = BENCH / "results"
DEFAULT_OUT = BENCH / "charts"

# 语言顺序/配色：与 FFT 对比图的视觉语言一致，但按本仓库跑分语料扩展。
LANG_STYLE = {
    "玄铁":   {"label": "玄铁 XTC",   "color": "#7C8395", "bold": True},
    "rust":   {"label": "Rust",       "color": "#5B7DB1", "bold": False},
    "node":   {"label": "Node (V8)",  "color": "#4E9B7A", "bold": False},
    "bun":    {"label": "Bun (JSC)",  "color": "#5C8FD6", "bold": False},
    "java":   {"label": "Java",       "color": "#D08A3E", "bold": False},
    "go":     {"label": "Go",         "color": "#3E8EC4", "bold": False},
    "python": {"label": "Python",     "color": "#C9A44C", "bold": False},
    "vix":    {"label": "Vix",        "color": "#8B5CF6", "bold": False},
    # issue #168 专图的小数数组形态(不是语言;只用于变体对比)
    "普通数组": {"label": "普通数组", "color": "#9AA3B2", "bold": True},
    "标注局部": {"label": "标注局部", "color": "#D08A3E", "bold": False},
    "小数数组": {"label": "小数数组", "color": "#8B5CF6", "bold": False},
    "标量":     {"label": "标量对照", "color": "#4E9B7A", "bold": False},
    "玄铁旧":   {"label": "玄铁 rc.5（外部）", "color": "#7C8395", "bold": True},
    "玄铁小数数组": {"label": "玄铁 + 小数数组（本机）", "color": "#8B5CF6", "bold": False},
}

# xt_bench.xt 的输出顺序；不在表里的新用例追加到末尾。
CASE_ORDER = [
    "空函数调用1e6",
    "字符串拼接1e5",
    "列表添加1e5",
    "字典插入1e4",
    "浮点累加1e6",
    "乘模1e6",
    "分支1e7",
    "嵌套循环1e6",
    "fib30递归",
]

# issue #168 专图:FFT 五语言外部实测 + 小数数组前后对比。
SPECIAL_RESULTS = [
    RESULTS / "2026-11-18-issue168-fft.json",
    RESULTS / "2026-11-20-issue168-f64array.json",
    RESULTS / "2026-11-20-issue168-fft-f64array.json",
]
TITLE_OVERRIDE = {
    "FFT4096点": "FFT 4096 点 · 单次",
    "FFT小数数组": "FFT 4096 点 · 小数数组优化",
    "小数数组4096x500": "小数数组微基准 · 4096×500",
}
SINGLE_RUN = {"FFT4096点", "FFT小数数组"}

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"),
    ("C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simhei.ttf"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
     "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
    ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/PingFang.ttc"),
]

W, MARGIN = 1400, 70
BAR_X, BAR_W = 340, 850
VALUE_X = W - MARGIN
ROW_H, BAR_H = 78, 40


def load_font(size, bold=False):
    for regular, bold_path in FONT_CANDIDATES:
        path = bold_path if bold else regular
        try:
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    raise SystemExit("找不到可用中文字体；请安装微软雅黑/Noto Sans CJK，或改 FONT_CANDIDATES")


def text_w(draw, text, font):
    return draw.textlength(text, font=font)


def fmt_total(us):
    if us is None:
        return "—"
    if us <= 0:
        return "0（编译期消除）"
    if us >= 1_000_000:
        return f"{us / 1_000_000:.2f} s"
    if us >= 1_000:
        return f"{us / 1_000:.2f} ms"
    if us >= 10:
        return f"{us:.0f} µs"
    return f"{us:.1f} µs"


def fmt_axis(us):
    if us >= 1_000_000:
        return f"{us / 1_000_000:g} s"
    if us >= 1_000:
        return f"{us / 1_000:g} ms"
    return f"{us:g} µs"


def fmt_ns(ns):
    if ns >= 1_000_000:
        return f"{ns / 1_000_000:.2f} ms"
    if ns >= 1_000:
        return f"{ns / 1_000:.2f} µs"
    if ns >= 10:
        return f"{ns:.0f} ns"
    return f"{ns:.2f} ns"


def fmt_ratio(us, base):
    if base is None or base <= 0:
        return "—"
    if us <= 0:
        return "≈0"
    r = us / base
    if r < 0.01:
        return "<0.01×"
    return f"{r:.2f}×"


def case_parts(name):
    m = re.match(r"^(.*?)(\d+)e(\d+)$", name)
    if not m:
        return name, None
    return m.group(1), int(m.group(2)) * (10 ** int(m.group(3)))


def case_title(name):
    if name in TITLE_OVERRIDE:
        return TITLE_OVERRIDE[name]
    base, count = case_parts(name)
    if count is None:
        return base
    return f"{base} · {count:,} 次"


def load_cases(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    grouped = {}
    for c in data.get("cases", []):
        grouped.setdefault(c["name"], {})[c["lang"].lower()] = c
    ordered = [n for n in CASE_ORDER if n in grouped]
    ordered += [n for n in grouped if n not in ordered]
    return data, [(n, list(grouped[n].items())) for n in ordered]


def pick_positive(items):
    return [c["median_us"] for _, c in items if c.get("median_us", 0) > 0]


def draw_chart(case_name, items, meta, source_name, out_path):
    base, count = case_parts(case_name)
    if case_name in SINGLE_RUN:
        count = 1
    base_lang = meta.get("baseline", "玄铁")
    base_entry = next((c for c in items if c[0] == base_lang), None)
    base_us = base_entry[1]["median_us"] if base_entry else None

    # 排序：0 值（编译期消除）置顶，其余按中位耗时升序，最快在上。
    ordered = sorted(items, key=lambda kv: (0 if kv[1]["median_us"] == 0 else 1,
                                             kv[1]["median_us"]))
    positives = pick_positive(ordered)
    if positives:
        # 用整十幂做轴界，保证 1/10/100ms 这类刻度一定出现；再给最小/最大值留边。
        lo = 10.0 ** math.floor(math.log10(min(positives)))
        hi = 10.0 ** math.ceil(math.log10(max(positives)))
        if lo * 1.02 > min(positives):
            lo /= 10.0
        if hi < max(positives) * 1.02:
            hi *= 10.0
    else:
        lo, hi = 1, 10

    rows = len(ordered)
    axis_y = 238 + rows * ROW_H
    table_y = axis_y + 78
    table_h = 44 + rows * 44
    height = table_y + table_h + 108

    img = Image.new("RGB", (W, height), "#FFFFFF")
    d = ImageDraw.Draw(img)
    f_title = load_font(42, bold=True)
    f_sub = load_font(19)
    f_section = load_font(21, bold=True)
    f_label = load_font(22)
    f_label_b = load_font(22, bold=True)
    f_value = load_font(20)
    f_axis = load_font(15)
    f_table = load_font(17)
    f_table_b = load_font(17, bold=True)
    f_small = load_font(14)

    # 标题区
    title = f"玄铁性能对比 · {case_title(case_name)}"
    d.text(((W - text_w(d, title, f_title)) / 2, 42), title, font=f_title, fill="#1F2937")
    sub = f"同一台机器 · 中位数越低越好 · 数据源 {source_name}"
    if meta.get("note"):
        sub = f"数据源 {source_name} · {meta['note']}"
    sub_font = f_sub
    if text_w(d, sub, sub_font) > W - 2 * MARGIN:
        sub_font = load_font(15)
    d.text(((W - text_w(d, sub, sub_font)) / 2, 104), sub, font=sub_font, fill="#6B7280")

    d.text((MARGIN, 168), "中位耗时（对数刻度，越短越快）", font=f_section, fill="#374151")
    d.text((W - MARGIN - text_w(d, "上：更快", f_axis), 174), "上：更快", font=f_axis, fill="#9CA3AF")

    # 背景网格（对数轴）
    exp_lo, exp_hi = math.floor(math.log10(lo)), math.ceil(math.log10(hi))
    grid_ticks = []
    for e in range(exp_lo, exp_hi + 1):
        v = 10.0 ** e
        if lo <= v <= hi:
            grid_ticks.append(v)
    if not grid_ticks:
        grid_ticks = [lo, hi]

    def x_of(v):
        if v <= 0:
            return BAR_X
        ratio = (math.log10(v) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))
        return BAR_X + max(0.0, min(1.0, ratio)) * BAR_W

    for v in grid_ticks:
        x = x_of(v)
        y = 220
        while y < axis_y + 4:
            d.line([(x, y), (x, min(y + 7, axis_y + 4))], fill="#E5E7EB", width=1)
            y += 14
        d.text((x - text_w(d, fmt_axis(v), f_axis) / 2, axis_y + 8), fmt_axis(v), font=f_axis, fill="#9CA3AF")

    # 每语言一行
    for i, (lang, c) in enumerate(ordered):
        us = c.get("median_us", 0)
        style = LANG_STYLE.get(lang, {"label": lang, "color": "#9CA3AF", "bold": False})
        y = 220 + i * ROW_H
        cy = y + ROW_H / 2

        d.text((MARGIN, cy - 13), style["label"], font=f_label_b if style["bold"] else f_label,
               fill="#111827" if style["bold"] else "#374151")

        # 轨道
        d.rounded_rectangle([BAR_X, cy - BAR_H / 2, BAR_X + BAR_W, cy + BAR_H / 2],
                            radius=BAR_H / 2, fill="#F3F4F6")

        if us > 0:
            x2 = x_of(us)
            x2 = max(x2, BAR_X + 8)  # 极小值也保留可见长度
            d.rounded_rectangle([BAR_X, cy - BAR_H / 2, x2, cy + BAR_H / 2],
                                radius=BAR_H / 2, fill=style["color"])
        else:
            # 0 = 编译期消除：画一个虚线小标记，避免 log(0)
            for xx in range(BAR_X, BAR_X + 46, 10):
                d.line([(xx, cy), (xx + 5, cy)], fill="#9CA3AF", width=2)

        val = fmt_total(us)
        d.text((VALUE_X - text_w(d, val, f_value), cy - 12), val, font=f_value,
               fill="#111827" if style["bold"] else "#374151")

    # 表格
    d.text((MARGIN, axis_y + 46), "数据明细", font=f_section, fill="#374151")
    base_label = LANG_STYLE.get(base_lang, {}).get("label", base_lang)
    cols = [MARGIN, 540, 760, 950, 1135]
    headers = ["语言 / 运行时", "总耗时（中位）", "单次", f"相对{base_label}", "样本"]
    d.rounded_rectangle([MARGIN, table_y, W - MARGIN, table_y + 40], radius=8, fill="#F3F4F6")
    for x, h in zip(cols, headers):
        d.text((x, table_y + 11), h, font=f_table_b, fill="#4B5563")

    for i, (lang, c) in enumerate(ordered):
        us = c.get("median_us", 0)
        style = LANG_STYLE.get(lang, {"label": lang, "color": "#9CA3AF", "bold": False})
        y = table_y + 40 + i * 44
        if style["bold"]:
            d.rectangle([MARGIN, y, W - MARGIN, y + 44], fill="#F9FAFB")
        d.line([(MARGIN, y), (W - MARGIN, y)], fill="#E5E7EB", width=1)

        d.ellipse([cols[0] + 2, y + 17, cols[0] + 12, y + 27], fill=style["color"])
        d.text((cols[0] + 22, y + 12), style["label"], font=f_table_b if style["bold"] else f_table,
               fill="#111827" if style["bold"] else "#374151")
        d.text((cols[1], y + 12), fmt_total(us), font=f_table, fill="#374151")
        if count:
            d.text((cols[2], y + 12), fmt_ns(us * 1000 / count) if us > 0 else "0", font=f_table, fill="#374151")
        else:
            d.text((cols[2], y + 12), "—", font=f_table, fill="#9CA3AF")
        d.text((cols[3], y + 12), fmt_ratio(us, base_us), font=f_table,
               fill="#111827" if style["bold"] else "#374151")
        d.text((cols[4], y + 12), str(len(c.get("all_us", []))), font=f_table, fill="#6B7280")

    # 页脚
    foot_y = table_y + table_h + 22
    machine = meta.get("machine", {})
    tool = meta.get("toolchain", {})
    version = tool.get("xtc_version", "玄铁")
    version = re.sub(r"^.*?v", "v", version)
    runs = meta.get("method", {}).get("runs", "?")
    env = f"环境：{machine.get('cpu', '?')} · {machine.get('platform', '?')} · 玄铁 {version} · 中位数（runs={runs}）"
    d.text((MARGIN, foot_y), env, font=f_small, fill="#9CA3AF")
    src = f"数据：bench/results/{source_name} · 生成：python bench/chart.py"
    d.text((MARGIN, foot_y + 24), src, font=f_small, fill="#9CA3AF")
    note = f"单次 = 总耗时 ÷ 迭代次数（fib30 无固定次数标 —）· 相对{base_label} <1 表示比基准更快 · 0 = 编译期消除/低于计时粒度"
    d.text((MARGIN, foot_y + 48), note, font=f_small, fill="#9CA3AF")

    img.save(out_path, "PNG", optimize=True)
    return {
        "case": case_name,
        "title": case_title(case_name),
        "file": out_path.name,
        "rows": rows,
        "base_us": base_us,
    }


def html_escape(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def write_index(out_dir, cards, meta, source_name):
    date = meta.get("date", "")
    cpu = meta.get("machine", {}).get("cpu", "")
    version = meta.get("toolchain", {}).get("xtc_version", "").strip()
    body = []
    for i, c in enumerate(cards, 1):
        body.append(f"""    <a class="card" href="{html_escape(c['file'])}">
      <img src="{html_escape(c['file'])}" alt="{html_escape(c['title'])}">
      <div class="cap"><b>{i:02d}. {html_escape(c['title'])}</b><span>基准中位 {html_escape(fmt_total(c['base_us']))}</span></div>
    </a>""")
    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>玄铁性能对比图</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: #F6F7F9; color: #111827;
         font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; }}
  header {{ padding: 34px 6vw 10px; }}
  h1 {{ margin: 0 0 8px; font-size: 28px; letter-spacing: .01em; }}
  p {{ margin: 0; color: #6B7280; font-size: 14px; line-height: 1.7; }}
  .grid {{ display: grid; gap: 18px; padding: 22px 6vw 48px;
           grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); }}
  .card {{ display: block; background: #fff; border: 1px solid #E5E7EB; border-radius: 14px;
           overflow: hidden; text-decoration: none; color: inherit;
           box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: box-shadow .15s, transform .15s; }}
  .card:hover {{ box-shadow: 0 8px 24px rgba(16,24,40,.10); transform: translateY(-2px); }}
  .card img {{ display: block; width: 100%; height: auto; }}
  .cap {{ display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px;
          font-size: 14px; color: #374151; border-top: 1px solid #F3F4F6; }}
  .cap span {{ color: #6B7280; white-space: nowrap; }}
  footer {{ padding: 0 6vw 36px; color: #9CA3AF; font-size: 12px; }}
  code {{ background: #EEF0F3; padding: 1px 5px; border-radius: 4px; }}
</style>
</head>
<body>
<header>
  <h1>玄铁性能对比图</h1>
  <p>每个基准用例一张图，对数刻度、越短越快；玄铁高亮。另含 issue #168 的 FFT 与小数数组专图。
     主数据：{html_escape(source_name)}（{html_escape(date)}），
     机器：{html_escape(cpu)}，工具链：{html_escape(version)}。</p>
</header>
<div class="grid">
{chr(10).join(body)}
</div>
<footer>重新生成：<code>python bench/chart.py</code> · 数据由 <code>bench/run.py</code> 产出，图由 <code>bench/chart.py</code> 渲染。</footer>
</body>
</html>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


def latest_measured():
    files = sorted(RESULTS.glob("*.json"))
    best = None
    for p in files:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("kind") != "measured":
            continue
        key = (d.get("date", ""), d.get("time", ""), p.name)
        if best is None or key > best[0]:
            best = (key, p)
    return best[1] if best else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=None, help="结果 JSON；缺省取最新 measured 快照")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录")
    ap.add_argument("--only", default=None, help="只生成名字含该子串的用例")
    args = ap.parse_args()

    src = Path(args.results) if args.results else latest_measured()
    if not src or not src.exists():
        sys.stderr.write("找不到结果 JSON；先运行 python bench/run.py --with-peers\n")
        return 2
    meta, cases = load_cases(src)
    indexed = [(i, n, it) for i, (n, it) in enumerate(cases, 1)]
    if args.only:
        indexed = [(i, n, it) for i, n, it in indexed if args.only in n]
    if not indexed:
        sys.stderr.write("没有匹配的用例\n")
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cards = []
    for shown, (i, name, items) in enumerate(indexed, 1):
        safe = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", name)
        path = out_dir / f"{i:02d}_{safe}.png"
        cards.append(draw_chart(name, items, meta, src.name, path))
        print(f"[{shown:02d}/{len(indexed):02d}] {name} -> {path.name}")

    # issue #168 专图：FFT 外部实测 + 小数数组前后对比（数据各自带 machine/note）。
    if not args.only:
        for sp in SPECIAL_RESULTS:
            if not sp.exists():
                continue
            smeta, scases = load_cases(sp)
            for name, items in scases:
                i = len(cards) + 1
                safe = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", name)
                path = out_dir / f"{i:02d}_{safe}.png"
                cards.append(draw_chart(name, items, smeta, sp.name, path))
                print(f"[{i:02d}] {name} -> {path.name}")

    if not args.only:
        write_index(out_dir, cards, meta, src.name)
        print(f"画廊: {out_dir / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
