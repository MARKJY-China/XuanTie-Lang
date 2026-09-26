# -*- coding: utf-8 -*-
# 玄铁 XTC 全量回归测试脚本(仓库版 —— 本地与 CI 共用的判定真源)
#
# 判定模型(四层,不依赖单一退出码):
#   1. 编译成功性:先删陈旧 exe 再编译,防「编译失败跑旧二进制」假绿。
#   2. 进程退出码/超时(崩溃、死锁直接 FAIL)。
#   3. 显式 FAIL 标记扫描。
#   4. 基线快照比对(golden diff):归一化后的全量输出与基准逐行对比,
#      任何输出异动(数值蹊跷、内容缺失)都拦下——解决「正常编译正常运行但输出有问题」。
#   并发类测试输出顺序天然不确定,使用「排序后比对」(只抓内容变化,不抓顺序)。
#
# 基线目录:Test/golden/(随仓库版本化;缺失基线的单元判 NO_GOLDEN 并计入异常)
# 日志目录:temp/regression_logs/(本地临时物,不入库)
#
# 用法(项目根目录):
#   python tools/regress.py --record           # 录制基线(仅当工具链状态被人工验证为正确时!)
#   python tools/regress.py                    # 回归比对(默认编译器 build/xtc_s4.exe)
#   python tools/regress.py --only 67          # 只跑文件名含 67 的测试
#   python tools/regress.py --skip 96_,97_,98_ # 跳过文件名含这些前缀的测试(弹窗类,CI 必跳)
#   python tools/regress.py --xtc build/xtc_s4.exe   # 指定编译器(自举各级对照用)
import os, re, subprocess, sys, time

# CI runner 的 stdout 默认编码不是 UTF-8(Windows runner 为 cp1252/en-US):
# 直接 print 中文(编译器路径行、测试名)会抛 UnicodeEncodeError 致整轮回归中断——
# 实测 GitHub Actions 上崩在 print("编译器: %s")。此处统一把标准输出/错误改为
# UTF-8 并对个别不可编码字符降级替换:任何区域设置下都能跑完全程。
# (注意:判定判定不依赖 stdout——基线读写均为显式 utf-8 文件 I/O,输出编码只影响展示。)
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CLI_XTC = None  # --xtc 显式指定;未指定时按下方 XTC_DEFAULT
XTC_DEFAULT = os.path.join(ROOT, "build", "xtc_s4.exe")
XTC_FALLBACK = os.path.join(ROOT, "xuantie_compiler", "xtc.exe")
XTC = XTC_DEFAULT if os.path.exists(XTC_DEFAULT) else XTC_FALLBACK
TESTDIR = os.path.join(ROOT, "Test")
GOLDEN_DIR = os.path.join(ROOT, "Test", "golden")
LOG_DIR = os.path.join(ROOT, "temp", "regression_logs")
# 产物目录(ASCII 路径):**必须显式 -sc 指定 ASCII 输出名**——
# XTC 未给 -sc 时会从源文件名派生输出路径(如 Test\01_基础测试.exe),该路径直通 gcc 的 -o;
# 在区域为 en-US(CP1252)的 CI runner 上,MinGW 的 gcc/ld 按 ANSI 码页解 argv,中文被
# 打成 "??.exe"(? 非法文件名字符) → ld: cannot open output file ??.exe → 全部单元 COMPILE_FAIL。
# 与 Issue #21(GSC 侧同因)同属一类,故此处统一走 ASCII 产物路径。
OUT_DIR = os.path.join(ROOT, "temp", "_regress_out")
COMPILE_TIMEOUT = 180
RUN_TIMEOUT = 300
# 并发/调度类压力单元在低核 CI 机器上明显更慢(实测 77_并发对抗压力 本机 22s / CI 244s,
# 且它们本身要跑 STRESS_REPEATS 轮),单独给更宽的时间上限,避免把"慢"误判成"挂死"。
RUN_TIMEOUT_STRESS = 900
# 无控制台环境(后台任务/CI)拉起子进程时不新配可见控制台窗口,杜绝回归期 CMD 频闪
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# 输出顺序不确定的测试(并发交错打印):排序后比对
SORTED_TESTS = {"08_", "09_", "58_", "59_", "60_", "66_", "67_", "68_", "69_",
                "70_", "71_", "72_", "73_", "74_", "75_", "77_", "99_", "123_"}

# 并发/调度相关测试:比对模式下反复运行 N 次,任何一次失败即判负(间歇竞态无处藏身)
STRESS_REPEATS = 3
STRESS_TESTS = {"58_", "59_", "60_", "66_", "67_", "68_", "69_", "70_", "71_",
                "72_", "73_", "74_", "75_", "77_", "99_",
                "110_", "111_", "112_", "113_", "114_", "115_", "116_", "117_", "121_", "123_",
                # 128/129: 嵌套异步块返回值 / 等待结果成员访问 —— 都走异步路径,同属易竞态组
                "128_", "129_"}

# 归一化:抹掉运行耗时、吞吐、内存地址等天然波动量
VOLATILE = [
    (re.compile(r"[<>]?\d+(?:\.\d+)?[MK]?\s*(?:微秒|毫秒|us|µs|ms|秒|次/秒|fiber/秒)"), "<T>"),
    (re.compile(r"耗时[:=]?\s*\d+"), "耗时=<T>"),
    (re.compile(r"0x[0-9A-Fa-f]+"), "<ADDR>"),
    (re.compile(r"Addr=[0-9A-Fa-f]+"), "Addr=<ADDR>"),
    (re.compile(r"Type=[0-9A-Fa-f]+"), "Type=<ADDR>"),
    (re.compile(r"Magic=[0-9A-Fa-f]+"), "Magic=<ADDR>"),
    (re.compile(r"(?:[0-9A-Fa-f]{2} ){3,}"), "<HEX>"),
    # raylib 内部资源计数器(ID编号随渲染桥/运行时布局波动,与程序正确性无关)
    (re.compile(r"\[ID \d+\]"), "[ID <N>]"),
    (re.compile(r"\d+ pixel size \| \d+ glyphs"), "<字体栅格>"),
    (re.compile(r"glyphs found: \[\d+/\d+\]"), "glyphs found: [<字体栅格>]"),
]

def normalize(text, sort_lines):
    text = text.replace("\r\n", "\n")
    for pat, rep in VOLATILE:
        text = pat.sub(rep, text)
    lines = []
    for ln in text.split("\n"):
        ln = ln.rstrip()
        if "║" in ln or "╔" in ln or "╚" in ln or "╠" in ln:
            ln = re.sub(r"[<>]?\d+(?:\.\d+)?[MK]?", "<N>", ln)  # 汇总框内的性能数值只核结构不核数值
        if ln.strip() != "":
            lines.append(ln)
    if sort_lines:
        lines.sort()
    return "\n".join(lines) + "\n"

def golden_path(name):
    return os.path.join(GOLDEN_DIR, name + ".golden.txt")

def run_cmd(argv, timeout, cwd=ROOT):
    try:
        p = subprocess.run(argv, cwd=cwd, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           creationflags=CREATE_NO_WINDOW)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", "replace")
        return "TIMEOUT", out + "\n[RUNNER] 超时终止\n"

def pick_error_lines(cout, max_lines=3):
    """从编译输出里挑出最能说明失败原因的行(末几行常是无关警告,不可作判据)。"""
    lines = [ln.rstrip() for ln in cout.replace("\r", "").split("\n") if ln.strip()]
    keys = ("错误", "失败", "error", "Error", "undefined", "cannot", "无法", "非法",
            "expected", "返回码", "exit status")
    hits = [ln for ln in lines if any(k in ln for k in keys)]
    picked = lines[-1:] + hits[:max_lines]
    seen, out = set(), []
    for ln in picked:
        if ln not in seen:
            seen.add(ln); out.append(ln)
    return " | ".join(out)[:400]

def one_test(xtfile, record):
    name = xtfile[:-3]  # 去 .xt
    src = os.path.join(TESTDIR, xtfile)
    m = re.match(r"^(\d+)_", name)
    exe = os.path.join(OUT_DIR, (m.group(1) if m else name) + ".exe")  # ASCII 产物路径(见 OUT_DIR 注释)
    sorted_mode = any(name.startswith(p) for p in SORTED_TESTS)
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(exe):
        os.remove(exe)  # 防陈旧二进制假绿

    rc, cout = run_cmd([XTC, "铁", src, "-sc", exe], COMPILE_TIMEOUT)
    compile_ok = (rc == 0 and os.path.exists(exe))
    compile_tail = pick_error_lines(cout)
    if not compile_ok:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, name + ".compile.log"), "w", encoding="utf-8") as f:
            f.write("=== 编译命令 ===\n%s 铁 %s -sc %s\n\n=== 编译输出 ===\n%s" % (XTC, src, exe, cout))

    # 压力单元的超时判定要在**首次**运行前就生效(此前只作用于重跑轮次,CI 上首次 304s 即被 300s 砍掉)
    is_stress = any(name.startswith(p) for p in STRESS_TESTS)
    run_timeout = RUN_TIMEOUT_STRESS if is_stress else RUN_TIMEOUT

    run_rc, run_out, = "", ""
    if compile_ok:
        run_rc, run_out = run_cmd([exe], run_timeout, cwd=ROOT)  # 部分测试用 "Test/..." 相对路径,必须以项目根为 CWD

    if record:
        os.makedirs(GOLDEN_DIR, exist_ok=True)
        with open(golden_path(name), "w", encoding="utf-8") as f:
            f.write("compile_ok=%s\n" % compile_ok)
            f.write("exit=%s\n" % run_rc)
            f.write(normalize(run_out, sorted_mode))
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, name + ".log"), "w", encoding="utf-8") as f:
            f.write("=== compile ===\n" + cout + "\n=== run(exit=%s) ===\n" % run_rc + run_out)
        tag = "REC" if compile_ok else "REC(COMPILE_FAIL)"
        return (tag, name, "")

    # 比对模式
    if not os.path.exists(golden_path(name)):
        return ("NO_GOLDEN", name, "Test/golden/ 下缺该单元基线")
    with open(golden_path(name), encoding="utf-8") as f:
        glines = f.read().split("\n")
    g_compile = glines[0].split("=", 1)[1] == "True"
    g_exit = glines[1].split("=", 1)[1]
    g_body = "\n".join(glines[2:])

    if not compile_ok:
        return ("COMPILE_FAIL" if g_compile else "PASS(预期编译失败-与基线一致)", name, compile_tail)

    # 并发类测试:反复运行 STRESS_REPEATS 次,每次都要与基线一致
    repeats = STRESS_REPEATS if is_stress else 1
    for attempt in range(repeats):
        if attempt > 0:
            run_rc, run_out = run_cmd([exe], run_timeout, cwd=ROOT)
        if run_rc == "TIMEOUT":
            return ("TIMEOUT(第%d次)" % (attempt + 1), name, "")
        if run_rc != 0 and str(run_rc) != g_exit:
            return ("CRASH(exit=%s,第%d次)" % (run_rc, attempt + 1), name, "")
        if "FAIL" in run_out:
            return ("FAIL标记(第%d次)" % (attempt + 1), name, "")
        if not g_compile:
            return ("基线为编译失败,本次竟编译成功(需人工确认)", name, "")
        if normalize(run_out, sorted_mode) != g_body:
            os.makedirs(LOG_DIR, exist_ok=True)
            with open(os.path.join(LOG_DIR, name + ".diff.log"), "w", encoding="utf-8") as f:
                f.write("=== 本次输出(第%d次) ===\n" % (attempt + 1) + run_out + "\n=== 基线(归一化) ===\n" + g_body)
            return ("DIFF(输出与基线不一致,第%d次)" % (attempt + 1), name, "详见 temp/regression_logs/%s.diff.log" % name)
    return ("PASS" if repeats == 1 else "PASS(x%d)" % repeats, name, "")

def main():
    record = "--record" in sys.argv
    only = None
    skip = []
    global XTC
    for i, a in enumerate(sys.argv):
        if a == "--only" and i + 1 < len(sys.argv):
            only = sys.argv[i + 1]
        if a == "--skip" and i + 1 < len(sys.argv):
            skip = [s for s in sys.argv[i + 1].split(",") if s]
        if a == "--xtc" and i + 1 < len(sys.argv):
            XTC = os.path.abspath(sys.argv[i + 1])
    if not os.path.exists(XTC):
        print("编译器不存在: %s(先自举或用 --xtc 指定)" % XTC)
        return 2
    xts = sorted(f for f in os.listdir(TESTDIR)
                 if re.match(r"^\d+_.*\.xt$", f) and (only is None or only in f)
                 and not any(s in f for s in skip))
    if not xts:
        print("无匹配测试"); return 2
    print("编译器: %s" % XTC)
    print("模式: %s | 测试数: %d | 跳过: %s" % ("录制基线" if record else "回归比对", len(xts), ",".join(skip) or "无"))
    bad = 0
    for xt in xts:
        t0 = time.time()
        verdict, name, note = one_test(xt, record)
        if not (verdict.startswith("PASS") or verdict in ("REC", "COMPILE_FAIL(与基线一致)")):
            bad += 1
        print("[%-32s] %-36s %s (%.1fs)" % (verdict, name, note, time.time() - t0))
    print("---")
    print("异常: %d / %d" % (bad, len(xts)))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
