# -*- coding: utf-8 -*-
# CI 专项门禁:跨编译单元 ABI(#140)、库编译模式 -lib(#141)、隐藏窗口可编译(#155)。
#
# 为什么单独一个脚本:这三项无法用 Test/ 下的单文件回归表达——
#   #140 需要两个库对象 + 主对象 + 手工链接;
#   #141 需要 -lib 产物再交给链接器;
#   #155 只需编译链接(不运行窗口),验证桥/API 存在。
#
# 用法(项目根):
#   python tools/check_abi_lib.py --xtc build/xtc_s4.exe
# 仅 Windows 运行手工链接分支;其他平台 #155 编译分支可跑。CI 只在 Windows gate 调。
import os
import shutil
import subprocess
import sys
import tempfile

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TMP = os.path.join(ROOT, "temp", "check_abi_lib")


def run(argv, cwd, timeout=180):
    r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def check(name, ok, detail=""):
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, (" — " + detail) if detail else ""))
    return ok


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    xtc = os.path.join(ROOT, "build", "xtc_s4.exe")
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--xtc" and i + 1 < len(args):
            xtc = os.path.abspath(args[i + 1])
    if not os.path.exists(xtc):
        print("编译器不存在: %s" % xtc)
        return 2
    if os.path.isdir(TMP):
        shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    ok = True

    # ---------- #155:隐藏窗口 API 可编译/可链接(不运行) ----------
    write(os.path.join(TMP, "hidden.xt"),
          '引 "../../lib/渲染/渲染.xt" 予 R\n'
          'R.初始化窗口隐藏(320, 240, "ci hidden")\n'
          'R.关闭窗口()\n')
    rc, out = run([xtc, "铁", "hidden.xt", "-sc", "hidden.exe"], TMP)
    ok &= check("#155 隐藏窗口 API 编译链接", rc == 0 and os.path.exists(os.path.join(TMP, "hidden.exe")),
                out.strip().splitlines()[-1] if out.strip() else "")

    if os.name != "nt":
        # 手工链接分支仅 Windows:CI 的 Windows gate 是唯一允许跑链接器实验的环境
        print("-- 非 Windows,跳过 #140/#141 手工链接")
        return 0 if ok else 1

    # ---------- #140:跨单元 extern bool ----------
    write(os.path.join(TMP, "liba.xt"), '公 函 丙正(甲: 整): 布尔 { 返 甲 > 0 }\n')
    write(os.path.join(TMP, "libb.xt"), '公 函 丁负(甲: 整): 布尔 { 返 甲 < 0 }\n')
    write(os.path.join(TMP, "main.xt"),
          '外 函 丙正(整): 布尔\n外 函 丁负(整): 布尔\n'
          '示("丙正(1)=" & 字(丙正(1)))\n示("丙正(-1)=" & 字(丙正(-1)))\n'
          '示("丁负(-5)=" & 字(丁负(-5)))\n示("丁负(5)=" & 字(丁负(5)))\n')
    for name in ("liba", "libb"):
        rc, out = run([xtc, "铁", name + ".xt", "-lib", "-sc", name + ".o"], TMP)
        if rc != 0 or not os.path.exists(os.path.join(TMP, name + ".o")):
            ok &= check("#141/%s -lib 对象编译" % name, False, out.strip()[-300:])
    # 主单元用 -bl 保留 自举输出.o(主对象);gcc/ld 走窄字符路径,中文名在部分工具链下打不开,
    # 先复制成 ASCII 名再链接(与编译器内部 raylib 路径中转同因)。
    rc, out = run([xtc, "铁", "main.xt", "-bl", "-sc", "main.exe"], TMP)
    produced = os.path.join(TMP, "自举输出.o")
    main_obj = os.path.join(TMP, "main_obj.o")
    if os.path.exists(produced):
        shutil.copyfile(produced, main_obj)
    ok &= check("#140 主对象生成(-bl)", os.path.exists(main_obj),
                out.strip().splitlines()[-1] if out.strip() else "")
    rt = os.path.join(ROOT, "build", "runtime")
    rt_objs = [os.path.join(rt, f) for f in ("xt_runtime.o", "xt_threadpool.o", "xt_net.o",
                                            "xt_tls.o", "xt_process.o")]
    gcc = shutil.which("gcc")
    if not gcc and os.name == "nt":
        cand = r"C:\TDM-GCC-64\bin\gcc.exe"
        if os.path.exists(cand):
            gcc = cand
    nm = shutil.which("nm")
    if not nm and os.name == "nt" and gcc:
        cand_nm = os.path.join(os.path.dirname(gcc), "nm.exe")
        if os.path.exists(cand_nm):
            nm = cand_nm
    if gcc and os.path.exists(main_obj) and all(os.path.exists(p) for p in rt_objs):
        link_exe = os.path.join(TMP, "abi.exe")
        rc, out = run([gcc, "-o", link_exe, main_obj,
                       os.path.join(TMP, "liba.o"), os.path.join(TMP, "libb.o")] + rt_objs +
                      ["-lws2_32", "-lsecur32"], TMP)
        if rc != 0 or not os.path.exists(link_exe):
            ok &= check("#140 两库+主对象链接", False, out.strip()[-300:])
        else:
            rc, out = run([link_exe], TMP)
            expect = ["丙正(1)=真", "丙正(-1)=假", "丁负(-5)=真", "丁负(5)=假"]
            ok &= check("#140 跨单元 extern bool 结果", rc == 0 and all(e in out for e in expect),
                        out.strip().replace("\n", " | "))
        # #141 的数据面:两个 -lib 对象 + 主对象已链接成功;再检查库对象无 main
        if os.path.exists(os.path.join(TMP, "liba.o")) and nm:
            rc, out = run([nm, os.path.join(TMP, "liba.o")], TMP)
            ok &= check("#141 库对象无 @main", rc == 0 and " T main" not in out and " T _main" not in out)
    else:
        print("SKIP: 未找到 gcc 或 build/runtime/*.o,跳过 #140/#141 手工链接")

    print("ABI/库模式专项: %s" % ("通过" if ok else "失败"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
