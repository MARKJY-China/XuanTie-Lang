# -*- coding: utf-8 -*-
# CI 门禁:issue #164 C ABI 导出。
# 流程:xtc -lib --emit-header → 检查 .h/ASCII 符号 → gcc 链接 C demo → 运行断言。
# 用法: python tools/check_c_abi.py --xtc build/xtc_s4.exe
import os, shutil, subprocess, sys, tempfile

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try: _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TMP = os.path.join(ROOT, "temp", "check_c_abi")

def run(argv, cwd=TMP, timeout=180):
    r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")

def check(name, ok, detail=""):
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, (" — " + detail) if detail else ""))
    return ok

def main():
    xtc = os.path.join(ROOT, "build", "xtc_s4.exe")
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--xtc" and i + 1 < len(args):
            xtc = os.path.abspath(args[i + 1])
    if not os.path.exists(xtc):
        print("编译器不存在: %s" % xtc); return 2
    if os.path.isdir(TMP): shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    ok = True
    shutil.copyfile(os.path.join(ROOT, "Test", "c_abi", "math.xt"), os.path.join(TMP, "math.xt"))
    shutil.copyfile(os.path.join(ROOT, "Test", "c_abi", "demo.c"), os.path.join(TMP, "demo.c"))
    obj = os.path.join(TMP, "libxtmath.o")
    hdr = os.path.join(TMP, "libxtmath.h")
    rc, out = run([xtc, "铁", "math.xt", "-lib", "-sc", "libxtmath.o", "--emit-header"])
    ok &= check("xtc -lib --emit-header 编译", rc == 0 and os.path.exists(obj) and os.path.exists(hdr),
                out.strip().splitlines()[-1] if out.strip() else "")
    if not os.path.exists(obj) or not os.path.exists(hdr):
        print("C ABI 门禁失败:缺少 .o/.h"); return 1
    h = open(hdr, encoding="utf-8").read()
    for sig in ("int64_t xt_add(int64_t", "int32_t xt_is_positive(int64_t",
                "char* xt_greet(const char*", "void xt_lib_init(void)"):
        ok &= check("头文件含 %s" % sig.split("(")[0], sig in h)

    nm = shutil.which("nm")
    if not nm and os.name == "nt":
        gcc = shutil.which("gcc")
        if gcc:
            cand = os.path.join(os.path.dirname(gcc), "nm.exe")
            if os.path.exists(cand): nm = cand
    if nm:
        rc, syms = run([nm, obj])
        text = syms
        for name in ("xt_add", "xt_is_positive", "xt_greet", "xt_lib_init"):
            ok &= check("nm 有 %s" % name, (" T " + name) in (" " + text))
        non_ascii = any(ord(ch) > 127 for ch in text)
        ok &= check("nm 无中文符号", not non_ascii, "发现非 ASCII" if non_ascii else "")
        ok &= check("nm 无 main", " T main" not in text and " T _main" not in text)
    else:
        print("SKIP: 未找到 nm")

    cc = shutil.which("gcc") or shutil.which("clang")
    if not cc:
        print("SKIP: 未找到 gcc/clang"); return 0 if ok else 1
    rt = os.path.join(ROOT, "build", "runtime")
    rt_objs = [os.path.join(rt, f) for f in ("xt_runtime.o", "xt_threadpool.o", "xt_net.o",
                                            "xt_tls.o", "xt_process.o")]
    libs = ["-lws2_32", "-lsecur32"] if os.name == "nt" else ["-lpthread", "-lm", "-ldl"]
    exe = os.path.join(TMP, "demo.exe" if os.name == "nt" else "demo")
    link = [cc, "-std=c11", "-I", TMP, "demo.c", obj] + rt_objs + libs + ["-o", exe]
    rc, out = run(link)
    ok &= check("C demo 链接", rc == 0 and os.path.exists(exe), out.strip()[-400:])
    if rc == 0 and os.path.exists(exe):
        rc, out = run([exe])
        ok &= check("C demo 运行(整数/布尔/字符串)", rc == 0 and "C_ABI_PASS" in out,
                    out.strip().replace("\n", " | "))
    print("C ABI 门禁: %s" % ("通过" if ok else "失败"))
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
