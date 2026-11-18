#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 编译冒烟.py —— lib/渲染 编译门禁（darwin / linux，不运行窗口程序）
#
# 背景（#161 审阅意见）：gate-darwin/gate-linux 此前只编译自举链与字符流库，
# 渲染库从未被 CI 编译过——字体链/高清等新增桥入口（XT_LoadFontChain、
# XT_LoadFontHiDPI）能否编译、能否链接，checks 全绿也证明不了。
#
# 校验三件事（与 lib/字符流/测试/编译冒烟.py 同一模式）：
#   1. 渲染.xt 通过 -jc 检查：词法/语法/语义全查，停在链接前；
#   2. 渲染.xt 能产出 -lib 库对象：库被引用时的编译形态；
#   3. 探针能实际编译 + 链接成可执行文件：探针引用 加载字体精准/加载字体高清/
#      加载字体全量高清/加载字体链 四个入口，覆盖「库 import → 渲染桥检测 →
#      渲染桥.c 编译 → raylib 静态链 → CoreText(-framework) 链接」整条链。
#
# 不运行产出的可执行文件——渲染初始化需要显示服务，运行验证留给有显示的
# 环境（见 #155 的同类边界）。
#
# 用法（仓库根目录）：
#   python3 lib/渲染/测试/编译冒烟.py --xtc build/xtc_s4.exe
#
# 退出码：0 = 全过；1 = 有失败；2 = 环境缺失（编译器/源文件/临时目录）
import argparse
import io
import os
import shutil
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
LIB_SRC = os.path.join(ROOT, "lib", "渲染", "渲染.xt")
TMP = os.path.join(ROOT, "temp", "lib_render_smoke")

# 探针：引用字体四入口。字符串路径不要求真实存在——本探针只编译链接，不运行。
PROBE = """\
// 渲染编译探针:字体四入口可见性 + 类型检查(只编译链接,不运行)
引 "渲染" 予 R

设 一 = R.加载字体精准("probe_font.ttf", 16, "ABC")
设 二 = R.加载字体高清("probe_font.ttf", 16, "ABC")
设 三 = R.加载字体全量高清("probe_font.ttf", 16)
设 四 = R.加载字体链("probe_main.ttf", "SFNS", 16, "汉字⌘")
若 一 < 0 或 二 < 0 或 三 < 0 或 四 < 0 { 终 1 }
终 0
"""

FAILS = []


def run(argv, cwd, timeout=300):
    """跑一条编译命令，UTF-8 收输出；返回 (退出码, 合并输出)。"""
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return 124, "超时（%ds）：%s" % (timeout, " ".join(argv))
    except OSError as exc:
        return 125, "无法启动编译器：%s" % exc
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def check(name, ok, detail=""):
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", name,
                        (" — " + detail.replace("\n", " | ")) if detail else ""))
    if not ok:
        FAILS.append(name)
    return ok


def main():
    ap = argparse.ArgumentParser(description="lib/渲染 编译冒烟（不运行窗口）")
    ap.add_argument("--xtc", default=os.path.join(ROOT, "build", "xtc_s4.exe"),
                    help="编译器路径（默认仓库 build/xtc_s4.exe）")
    args = ap.parse_args()

    xtc = os.path.abspath(args.xtc)
    if not os.path.exists(xtc):
        print("环境缺失：找不到编译器 %s" % xtc)
        return 2
    if not os.path.exists(LIB_SRC):
        print("环境缺失：找不到源文件 %s" % LIB_SRC)
        return 2

    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    lib_obj = os.path.join(TMP, "render_lib.o")
    probe_src = os.path.join(TMP, "渲染探针.xt")
    exe = os.path.join(TMP, "render_probe" + (".exe" if os.name == "nt" else ""))
    io.open(probe_src, "w", encoding="utf-8").write(PROBE)

    print("编译器：%s" % xtc)
    print("临时目录：%s" % TMP)
    print("平台：%s" % sys.platform)

    # 1) -jc 检查：只查不产出
    rc, out = run([xtc, "铁", LIB_SRC, "-jc"], ROOT)
    check("渲染.xt -jc 语法/语义检查", rc == 0 and "检查完成" in out,
          "退出码=%d" % rc if rc != 0 else ("" if "检查完成" in out else "未见「检查完成」标记"))

    # 2) -lib 库对象：真实走库编译分支，证明无 main 的库单元可独立编译
    rc, out = run([xtc, "铁", LIB_SRC, "-lib", "-sc", lib_obj], ROOT)
    check("渲染.xt -lib 库对象编译", rc == 0 and os.path.exists(lib_obj),
          "退出码=%d" % rc if rc != 0 else ("" if os.path.exists(lib_obj) else "未产出 %s" % lib_obj))

    # 3) -sc 编译链接探针：引 "渲染" → 渲染桥检测 → 渲染桥.c 编译 → raylib 静态链
    #    （darwin 上同时验证链接串含 -framework CoreText 时字体链符号可解析）
    rc, out = run([xtc, "铁", probe_src, "-sc", exe], ROOT)
    check("渲染探针 -sc 编译+链接（字体四入口）", rc == 0 and os.path.exists(exe),
          "退出码=%d" % rc if rc != 0 else ("" if os.path.exists(exe) else "未产出 %s" % exe))

    if FAILS:
        print("\n渲染编译冒烟失败：%s" % "、".join(FAILS))
        return 1
    print("\n渲染编译冒烟通过：-jc / -lib + 字体四入口探针 -sc 链接全部成功（未运行窗口）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
