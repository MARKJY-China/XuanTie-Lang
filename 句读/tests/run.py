# -*- coding: utf-8 -*-
# 句读黄金测试 harness(信任锚门禁)
#
# 流程:解析 tests/黄金.jd → 每条测试:
#   转译器链路:  试NN.jd → jdt.exe → 玄铁源码 → xtc → 二进制 → stdout
#   参考解释器:  试NN.jd → 解释器.py → stdout
#   两路 stdout 与【期出】三方逐行比对(仅归一化换行符,其余逐字节);
#   出错类测试(【期失】)比对错误首行(类目+卷+行号)并要求两实现全文一致。
#
# 用法(仓库根目录):
#   python 句读/tests/run.py                # 全部 20 条(转译器源码有变动时自动重建)
#   python 句读/tests/run.py --only 3       # 只跑试〇三(3 / 03 / 试〇三 均可)
#   python 句读/tests/run.py --overwrite    # 以转译器链路输出重录期望(必须人工 review 后提交)
#   python 句读/tests/run.py --keep         # 保留 build/ 中间产物(默认测试后清理 .jd/.xt/.exe)
#   python 句读/tests/run.py --rebuild      # 强制重建转译器
import os, re, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
JD = os.path.join(ROOT, "句读")
BUILD = os.path.join(JD, "build")
SRC = os.path.join(JD, "src")
XTC = os.path.join(ROOT, "build", "xtc_s4.exe")
JDT = os.path.join(BUILD, "jdt.exe")
INTERP = os.path.join(JD, "ref", "解释器.py")
GOLD = os.path.join(JD, "tests", "黄金.jd")
COMPILE_TIMEOUT = 180
RUN_TIMEOUT = 60
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def run_cmd(argv, timeout, cwd=ROOT):
    try:
        p = subprocess.run(argv, cwd=cwd, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           creationflags=CREATE_NO_WINDOW)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", "replace")
        return "TIMEOUT", out + "\n[harness] 超时终止\n"


def norm(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


# ---------- 解析黄金测试 ----------
def parse_golden(path):
    raw = norm(open(path, encoding="utf-8").read())
    tests, cur = [], None
    sec = None  # None / "jd" / "out" / "fail"
    for line in raw.split("\n"):
        m = re.match(r"^—— (试[〇一二三四五六七八九十]+)·(.+) ——\s*$", line)
        if m:
            cur = {"id": m.group(1), "name": m.group(2), "src": [], "out": None, "fail": None}
            tests.append(cur); sec = "jd"; continue
        if cur is None:
            continue
        if line.strip() == "【句读】":
            sec = "jd"; continue
        if line.strip() == "【期出】":
            cur["out"] = []; sec = "out"; continue
        if line.strip() == "【期失】":
            cur["fail"] = []; sec = "fail"; continue
        if line.strip() == "" and sec in ("out", "fail"):
            sec = "jd"; continue  # 期望块以空行收束
        if sec == "jd":
            cur["src"].append(line)
        elif sec == "out":
            cur["out"].append(line)
        elif sec == "fail":
            cur["fail"].append(line)
    for t in tests:
        t["src"] = "\n".join(t["src"])
        if t["out"] is not None:
            t["out"] = "\n".join(t["out"]) + "\n"
        if t["fail"] is not None:
            t["fail"] = "\n".join(t["fail"])
    return tests


# ---------- 转译器构建 ----------
def src_newer_than(exe):
    if not os.path.exists(exe):
        return True
    exe_t = os.path.getmtime(exe)
    for d in (SRC, os.path.join(JD, "runtime")):
        for f in os.listdir(d):
            if f.endswith(".xt") and os.path.getmtime(os.path.join(d, f)) > exe_t:
                return True
    return False


def build_transpiler(force=False):
    if not force and not src_newer_than(JDT):
        return True, "未变动,跳过"
    if not os.path.exists(XTC):
        return False, "缺宿主编译器 %s" % XTC
    os.makedirs(BUILD, exist_ok=True)
    t0 = time.time()
    rc, out = run_cmd([XTC, "铁", os.path.relpath(os.path.join(SRC, "主.xt"), ROOT),
                       "-sc", os.path.relpath(JDT, ROOT)], COMPILE_TIMEOUT)
    ok = rc == 0 and os.path.exists(JDT)
    return ok, ("%.1fs" % (time.time() - t0)) if ok else out[-1500:]


# ---------- 单条测试 ----------
def run_one(t, keep):
    tid = t["id"]
    base = os.path.join(BUILD, tid)          # 试〇三
    jdfile = base + ".jd"
    xtfile = base + ".xt"
    exefile = base + ".exe"
    with open(jdfile, "w", encoding="utf-8", newline="\n") as f:
        f.write(t["src"] + "\n")

    # 链路一:转译器 → 玄铁 → xtc → 运行
    rc, out = run_cmd([JDT, tid + ".jd", "-o", tid + ".xt"], COMPILE_TIMEOUT, cwd=BUILD)
    jd_out = norm(out)
    if "【" in jd_out or rc != 0:
        transpiled = jd_out if jd_out.endswith("\n") else jd_out + "\n"
    else:
        rc2, cout = run_cmd([XTC, "铁", os.path.relpath(xtfile, ROOT),
                             "-sc", os.path.relpath(exefile, ROOT)], COMPILE_TIMEOUT)
        if rc2 != 0 or not os.path.exists(exefile):
            transpiled = "[harness] 生成码编译失败\n" + cout[-1500:]
        else:
            rc3, rout = run_cmd([exefile], RUN_TIMEOUT, cwd=BUILD)
            transpiled = norm(rout)
            if rc3 == "TIMEOUT":
                transpiled += "[harness] 运行超时\n"

    # 链路二:参考解释器
    rc4, pout = run_cmd([sys.executable, INTERP, tid + ".jd"], RUN_TIMEOUT, cwd=BUILD)
    pyout = norm(pout)
    if not pyout.endswith("\n") and pyout != "":
        pyout += "\n"

    if not keep:
        for f in (jdfile, xtfile, exefile):
            if os.path.exists(f):
                try: os.remove(f)
                except OSError: pass

    if t["fail"] is not None:
        # 期失:错误块可前有正常输出;比对=错误行见于两实现 + 双实现全文一致
        tlines = norm(transpiled).split("\n")
        plines = norm(pyout).split("\n")
        problems = []
        if t["fail"] not in tlines:
            problems.append("转译链路未报出期失行")
        if t["fail"] not in plines:
            problems.append("参考解释器未报出期失行")
        if norm(transpiled) != norm(pyout):
            problems.append("两实现输出分歧")
        return problems, transpiled, pyout

    problems = []
    if transpiled != t["out"]:
        problems.append("转译链路输出不合期出")
    if pyout != t["out"]:
        problems.append("参考解释器输出不合期出")
    return problems, transpiled, pyout


def first_diff(a, b, n=6):
    la, lb = norm(a).split("\n"), norm(b).split("\n")
    out = []
    for i in range(max(len(la), len(lb))):
        x = la[i] if i < len(la) else "<缺>"
        y = lb[i] if i < len(lb) else "<缺>"
        if x != y:
            out.append("  第%d行  期=%r  实=%r" % (i + 1, x, y))
            if len(out) >= n:
                break
    return "\n".join(out)


# ---------- 主流程 ----------
def main():
    only, overwrite, keep, rebuild = None, False, False, False
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--only":
            i += 1; only = argv[i]
        elif a == "--overwrite": overwrite = True
        elif a == "--keep": keep = True
        elif a == "--rebuild": rebuild = True
        else:
            print("未知参数:", a); return 2
        i += 1

    tests = parse_golden(GOLD)
    print("黄金测试 %d 条" % len(tests))

    ok, msg = build_transpiler(rebuild)
    print("转译器:", "构建成功(" + msg + ")" if ok else "构建失败:\n" + msg)
    if not ok:
        return 2

    if only:
        num = re.sub(r"^试", "", only)
        if num.isdigit():
            want = int(num)
        else:
            want = cn_num(only)
        tests = [t for t in tests if cn_num(t["id"]) == want]
        if not tests:
            print("--only 未命中任何测试"); return 2

    passed, failed = 0, []
    for t in tests:
        problems, tout, pout = run_one(t, keep)
        if not problems:
            passed += 1
            print("[绿] %s·%s" % (t["id"], t["name"]))
        else:
            failed.append((t, problems, tout, pout))
            print("[红] %s·%s  (%s)" % (t["id"], t["name"], ";".join(problems)))

    print()
    for t, problems, tout, pout in failed:
        print("—— %s·%s ——" % (t["id"], t["name"]))
        for p in problems:
            print("  ✗", p)
        if t["out"] is not None and "期出" in ";".join(problems):
            print("  期出 vs 转译链路:")
            print(first_diff(t["out"] or "", tout))
            print("  期出 vs 参考解释器:")
            print(first_diff(t["out"] or "", pout))
        else:
            print("  转译链路:", repr(tout[:300]))
            print("  参考解释器:", repr(pout[:300]))
        print()

    total = len(tests)
    print("摘要: %d/%d 全绿" % (passed, total))
    if overwrite and failed:
        do_overwrite(failed)
    return 0 if passed == total else 1


def cn_num(tid):
    s = re.sub(r"^试", "", tid)
    conv = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9}
    # 测试编号皆直书体(〇六=6,一〇=10,二〇=20),逐位拼接
    total = 0
    for ch in s:
        if ch not in conv:
            return -1
        total = total * 10 + conv[ch]
    return total


def do_overwrite(failed):
    print("--overwrite: 以下测试期望将被重录(人工 review 前不得提交):")
    for t, _, tout, pout in failed:
        if norm(tout) != norm(pout):
            print("  跳过 %s:两实现分歧,先改规范" % t["id"])
            continue
        with open(GOLD, "r", encoding="utf-8", newline="") as f:
            content = f.read()
        tname = t["id"]
        # 仅当转译链路输出非空才录
        new_expect = tout if t["fail"] is None else tout.split("\n")[0]
        key = "【期失】" if t["fail"] is not None else "【期出】"
        pat = re.compile(
            r"(—— %s·[^——]+ ——\n【句读】\n.*?\n)%s\n(.*?)(?=\n\n—— |\n\n?$)" % (re.escape(tname), key),
            re.S)
        block = new_expect if isinstance(new_expect, str) else "\n".join(new_expect)
        content2 = pat.sub(lambda m: m.group(1) + key + "\n" + block.rstrip("\n"), content, count=1)
        if content2 == content:
            print("  跳过 %s:未定位到期望块" % tname)
            continue
        with open(GOLD, "w", encoding="utf-8", newline="") as f:
            f.write(content2)
        print("  已重录 %s" % tname)


if __name__ == "__main__":
    sys.exit(main())
