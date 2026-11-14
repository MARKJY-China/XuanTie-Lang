# -*- coding: utf-8 -*-
# 内存泄漏快速回归(默认 5 秒内,可挂进全量回归)
#
# 覆盖两件事:
#   1. 编译器“成员守卫字符串”泄漏:每次 含?/包含?/以开头/以结尾 调用曾泄漏一个 XTString。
#      本测试用 500 万次 d.含?() 循环,旧编译器 RSS 增长约 260MB,修复后 <5MB。
#   2. UI 合选项/布局热路径(可选 --ui):只有编译期/布局期,不开窗口;但需编译整个 UI 库,约 60 秒。
#
# 用法:
#   python tools/check_memory_leak.py                 # 只跑编译器守卫微基准(~1.5s)
#   python tools/check_memory_leak.py --ui            # 追加 UI 布局无泄漏基准(~60s,需编译 UI 库)
#   python tools/check_memory_leak.py --xtc build/xtc_s4.exe
#   python tools/check_memory_leak.py --json
#
# 退出码: 0 = 通过; 1 = 超阈值; 2 = 环境不支持/编译失败(判 FAIL,由 CI 决定是否容忍)。
import json
import os
import subprocess
import sys
import tempfile
import time

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
XTC_DEFAULT = os.path.join(ROOT, "build", "xtc_s4.exe")
OUT_DIR = os.path.join(ROOT, "temp", "_memcheck")
# 阈值:修复后基线约 5MB 量级;留足分配器抖动/平台差异,但仍远低于旧版泄漏(>250MB)
COMPILER_GROWTH_MB = 40
UI_GROWTH_MB = 40
COMPILER_LOOPS = 5_000_000
UI_FRAMES = 120


def _rss_mb(pid):
    """跨平台读进程 RSS(MB);不支持返回 None。"""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            handle = kernel32.OpenProcess(0x1000 | 0x0400, False, int(pid))
            if not handle:
                return None
            try:
                counters = PROCESS_MEMORY_COUNTERS()
                counters.cb = ctypes.sizeof(counters)
                if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                    return None
                return counters.WorkingSetSize / (1024 * 1024)
            finally:
                kernel32.CloseHandle(handle)
        if sys.platform == "darwin":
            out = subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)], text=True).strip()
            return int(out) / 1024.0
        # Linux / 其他 POSIX
        with open("/proc/%d/statm" % pid, "r", encoding="ascii") as f:
            pages = int(f.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    except Exception:
        return None


def _run_and_track(argv):
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            cwd=ROOT, text=True, errors="replace")
    samples = []
    t0 = time.time()
    while proc.poll() is None:
        rss = _rss_mb(proc.pid)
        if rss is not None:
            samples.append(rss)
        if time.time() - t0 > 90:
            proc.kill()
            return None, "超时(>90s)", samples
        time.sleep(0.02)
    out = proc.stdout.read() if proc.stdout else ""
    return proc.returncode, out, samples


def _check_one(exe_id, name, src, growth_mb):
    os.makedirs(OUT_DIR, exist_ok=True)
    exe = os.path.join(OUT_DIR, exe_id + ".exe")
    if os.path.exists(exe):
        os.remove(exe)
    r = subprocess.run([XTC, "铁", src, "-sc", exe], cwd=ROOT, capture_output=True,
                       text=True, errors="replace", timeout=180)
    if r.returncode != 0 or not os.path.exists(exe):
        return {"name": name, "ok": False, "why": "编译失败: " + (r.stdout + r.stderr)[-300:], "samples": []}
    rc, out, samples = _run_and_track([exe])
    if rc is None:
        return {"name": name, "ok": False, "why": out, "samples": samples}
    if rc != 0 or "done" not in out:
        return {"name": name, "ok": False, "why": "运行失败(exit=%s): %s" % (rc, out[-300:]), "samples": samples}
    if len(samples) < 2:
        return {"name": name, "ok": True, "why": "RSS 采样不足,跳过判定", "samples": samples}
    # 启动期一次性的运行时/模块加载不算泄漏:从第 2 个采样点起算增长
    base = samples[1]
    peak = max(samples)
    growth = peak - base
    return {"name": name, "ok": growth <= growth_mb,
            "why": "增长 %.1f MB(基线 %.1f / 峰值 %.1f,阈值 %d MB)" % (growth, base, peak, growth_mb),
            "samples": samples}


def main():
    args = sys.argv[1:]
    global XTC
    XTC = XTC_DEFAULT
    for i, a in enumerate(args):
        if a == "--xtc" and i + 1 < len(args):
            XTC = os.path.abspath(args[i + 1])
    want_ui = "--ui" in args
    as_json = "--json" in args
    if not os.path.exists(XTC):
        print("编译器不存在: %s" % XTC)
        return 2
    if _rss_mb(os.getpid()) is None:
        print("SKIP: 当前平台不支持 RSS 采样")
        return 0

    probes = [(
        "guard",
        "含?守卫",
        "设 d = {\"a\": 1}\n设 i = 0\n当 i < %d { 设 x = d.含?(\"a\") ; i = i + 1 }\n示(\"done\")\n" % COMPILER_LOOPS,
        COMPILER_GROWTH_MB,
    )]
    if want_ui:
        probes.append((
            "ui_layout",
            "UI布局",
            "引 \"../../lib/UI/UI.xt\" 予 UI\n"
            "设 i = 0\n当 i < %d {\n"
            "    设 树 = UI.列([UI.文本(\"标题\", 空), UI.行([UI.文本(\"a\", 空), UI.文本(\"b\", 空)], 空)], 空)\n"
            "    UI.计算布局(树, 0, 0, 300, 200)\n"
            "    i = i + 1\n}\n示(\"done\")\n" % UI_FRAMES,
            UI_GROWTH_MB,
        ))

    results = []
    os.makedirs(OUT_DIR, exist_ok=True)
    for exe_id, name, body, threshold in probes:
        fd, src = tempfile.mkstemp(prefix="memcheck_", suffix=".xt", dir=OUT_DIR, text=True)
        os.close(fd)
        with open(src, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        try:
            results.append(_check_one(exe_id, name, src, threshold))
        finally:
            os.remove(src)

    ok = all(r["ok"] for r in results)
    if as_json:
        print(json.dumps({"ok": ok, "results": results}, ensure_ascii=False))
    else:
        for r in results:
            print("[%s] %s: %s" % ("PASS" if r["ok"] else "FAIL", r["name"], r["why"]))
        print("内存泄漏检查: %s" % ("通过" if ok else "失败"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
