#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 编译冒烟.py —— lib/字符流 跨平台编译门禁（Windows / Linux / macOS 同一份，不运行 TUI）
#
# 校验三件事（缺一不可）：
#   1. 字符流.xt 通过 -jc 检查：词法/语法/语义全查，停在链接前；
#   2. 字符流.xt 能产出 -lib 库对象：库被引用时的编译形态（顶层初始化警告属预期）；
#   3. 示例.xt 能实际编译 + 链接成可执行文件：覆盖「库 import → IR → runtime .o →
#      gcc/clang 链接」整条链（CI 上 gcc 由镜像/前置步骤提供）。
#
# 为什么不写成 CI 里的一行 bash：Windows runner 的 bash 到 gcc 之间是窄字符路径，
# 中文源文件名/参数容易踩编码坑；本脚本用 subprocess 以 Unicode 传参、按 UTF-8 收
# 输出，三平台行为一致，且能对「退出码 0 但没产物」显式判失败。
#
# 不运行产出的可执行文件——TUI 需要真终端，运行验证在 Unix pty 用例里
# （示例驱动.py / C1读字节超时.py），Windows 不跑 TUI。
#
# 用法（仓库根目录）：
#   python lib/字符流/测试/编译冒烟.py --xtc build/xtc_s4.exe
#   python3 lib/字符流/测试/编译冒烟.py --xtc build/xtc_s4.exe
#
# 退出码：0 = 全过；1 = 有失败；2 = 环境缺失（编译器/源文件/临时目录）
import argparse
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
LIB_SRC = os.path.join(ROOT, "lib", "字符流", "字符流.xt")
EXAMPLE_SRC = os.path.join(ROOT, "lib", "字符流", "示例.xt")
TMP = os.path.join(ROOT, "temp", "lib_charstream_smoke")

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
    ap = argparse.ArgumentParser(description="lib/字符流 跨平台编译冒烟")
    ap.add_argument("--xtc", default=os.path.join(ROOT, "build", "xtc_s4.exe"),
                    help="编译器路径（默认仓库 build/xtc_s4.exe）")
    args = ap.parse_args()

    xtc = os.path.abspath(args.xtc)
    if not os.path.exists(xtc):
        print("环境缺失：找不到编译器 %s" % xtc)
        return 2
    for src in (LIB_SRC, EXAMPLE_SRC):
        if not os.path.exists(src):
            print("环境缺失：找不到源文件 %s" % src)
            return 2

    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    lib_obj = os.path.join(TMP, "charstream_lib.o")
    exe = os.path.join(TMP, "charstream_example" + (".exe" if os.name == "nt" else ""))

    print("编译器：%s" % xtc)
    print("临时目录：%s" % TMP)
    print("平台：%s" % sys.platform)

    # 1) -jc 检查：只查不产出
    rc, out = run([xtc, "铁", LIB_SRC, "-jc"], ROOT)
    check("字符流.xt -jc 语法/语义检查", rc == 0 and "检查完成" in out,
          "退出码=%d" % rc if rc != 0 else ("" if "检查完成" in out else "未见「检查完成」标记"))

    # 2) -lib 库对象：真实走库编译分支，证明无 main 的库单元可独立编译
    rc, out = run([xtc, "铁", LIB_SRC, "-lib", "-sc", lib_obj], ROOT)
    check("字符流.xt -lib 库对象编译", rc == 0 and os.path.exists(lib_obj),
          "退出码=%d" % rc if rc != 0 else ("" if os.path.exists(lib_obj) else "未产出 %s" % lib_obj))

    # 3) -sc 编译链接示例：示例引 "./字符流.xt"，覆盖库 import + 链接链
    rc, out = run([xtc, "铁", EXAMPLE_SRC, "-sc", exe], ROOT)
    check("示例.xt -sc 编译+链接", rc == 0 and os.path.exists(exe),
          "退出码=%d" % rc if rc != 0 else ("" if os.path.exists(exe) else "未产出 %s" % exe))

    if FAILS:
        print("\n编译冒烟失败：%s" % "、".join(FAILS))
        return 1
    print("\n编译冒烟通过：library -jc / -lib + 示例 -sc 链接全部成功（未运行 TUI）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
