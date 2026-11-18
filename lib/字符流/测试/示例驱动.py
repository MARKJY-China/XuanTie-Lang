#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 示例驱动.py —— pty 驱动 lib/字符流/示例.xt 的编译产物，验证库的全事件形态（库级测试）
#
# 覆盖 8 项断言：普通键（码=97）/ 方向键上（码=1001）/ SGR 鼠标左键按下（按钮=0 动作=按下）/
# 滚轮上（按钮=64 动作=上滚）/ 孤 ESC（码=27）/ 退出恢复序列（ESC[?1049l）。
#
# 平台口径：
#   - Unix（Linux/macOS）：pty 驱动，真跑 TUI 程序——本脚本的正式用途（CI 在这两个平台跑）。
#   - Windows：没有 Unix pty，脚本只做一次「示例.xt 编译+链接」冒烟，然后明确 SKIP 交互测试。
#     Windows 交互路径由运行时 ReadConsoleInputW 后端提供，CI 的 Windows gate 只做编译门禁。
#
# 用法（仓库根目录）：
#   python3 lib/字符流/测试/示例驱动.py --xtc build/xtc_s4.exe
#   python3 lib/字符流/测试/示例驱动.py --xtc build/xtc_s4.exe --require-pty   # CI：禁止静默跳过
#
# 退出码：0 = 8 项断言全过（或非 Unix 明确 SKIP）；1 = 断言失败；2 = 编译/环境失败。
import argparse
import os
import select
import shutil
import struct
import subprocess
import sys
import time

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXAMPLE_SRC = os.path.join(ROOT, "lib", "字符流", "示例.xt")
TMP = os.path.join(ROOT, "temp", "lib_charstream_pty")
IS_UNIX = (os.name == "posix")
# pty/fcntl/termios 仅 Unix 有：Windows 上允许本脚本被导入/运行（走「编译后 SKIP」分支），
# 故不放在文件顶部无条件 import。
if IS_UNIX:
    import fcntl
    import pty
    import termios

CHECKS = [
    "码=97",                 # 普通键 a
    "码=1001",               # 方向键上 ESC[A
    "按钮=0", "动作=按下",     # SGR 左键按下
    "按钮=64", "动作=上滚",    # SGR 滚轮上
    "码=27",                 # 孤 ESC
    "\x1b[?1049l",           # 退出恢复：出备用屏
]


def fail(msg):
    print("❌ %s" % msg)
    return 2


def build_example(xtc):
    """编译 示例.xt 到临时目录（ASCII 产物名：Windows 的 gcc/ld 走窄字符路径，中文产物名会打不开）。"""
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    exe = os.path.join(TMP, "charstream_example" + (".exe" if os.name == "nt" else ""))
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    try:
        r = subprocess.run([xtc, "铁", EXAMPLE_SRC, "-sc", exe], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print("❌ 无法编译示例：%s" % exc)
        return None
    if r.returncode != 0 or not os.path.exists(exe):
        print("❌ 示例编译/链接失败（退出码 %d）：" % r.returncode)
        print((r.stdout or "") + (r.stderr or ""))
        return None
    print("示例已编译：%s" % exe)
    return exe


def run_under_pty(exe, timeout_s=30.0):
    """在带控制终端的 pty 中运行示例，按脚本输入事件；返回 (合并输出文本, 子进程退出码)。"""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    pid = os.fork()
    if pid == 0:  # 子进程
        try:
            os.close(master)
            os.setsid()                                  # 脱离父会话
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)     # 把 pty 设为控制终端（/dev/tty 可打开的前提）
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.execv(exe, [exe])
        except BaseException:
            os._exit(127)
    os.close(slave)

    out = bytearray()
    status = None

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            out.extend(chunk)

    def wait_for(marker, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if marker in out:
                return True
            pump(0.05)
        return marker in out

    try:
        # 等示例进入原始模式（进备用屏/清屏/开鼠标的进入序列已打完）。注意：示例在收到
        # 第一个键事件之前不会画第一帧，所以不能拿"字符流示例"当就绪标记——
        # 以最后一条进入序列 ESC[?1006h 为准；CI runner 冷启动慢，给 15s。
        if not wait_for(b"\x1b[?1006h", 15.0):
            print("❌ 示例未在 15s 内进入原始模式（未见进入序列 ESC[?1006h）")
            return None, -1
        pump(0.1)
        os.write(master, b"a")                    # 普通键
        pump(0.5)
        os.write(master, b"\x1b[A")               # 方向键上
        pump(0.5)
        os.write(master, b"\x1b[<0;10;3M")        # SGR 左键按下
        pump(0.5)
        os.write(master, b"\x1b[<64;10;3M")       # SGR 滚轮上
        pump(0.5)
        os.write(master, b"\x1b")                 # 孤 ESC（100ms 无后续 → 码 27）
        pump(0.5)
        os.write(master, b"\r")                   # 回车退出
        # 等程序自己正常退出（恢复终端 + 退出），最多 timeout_s
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            pump(0.05)
            wpid, st = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                status = st
                break
        # 子进程退出后把 pty 缓冲里剩余输出（退出恢复序列）收干净再断言
        while status is not None:
            r, _, _ = select.select([master], [], [], 0)
            if not r:
                break
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            out.extend(chunk)
    finally:
        if status is None:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass
        try:
            os.close(master)
        except OSError:
            pass

    text = bytes(out).decode("utf-8", "replace")
    if status is None:
        return text, -1
    return text, (os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status)


def main():
    ap = argparse.ArgumentParser(description="lib/字符流 示例全事件 pty 测试")
    ap.add_argument("--xtc", default=os.path.join(ROOT, "build", "xtc_s4.exe"),
                    help="编译器路径（默认仓库 build/xtc_s4.exe）")
    ap.add_argument("--require-pty", action="store_true",
                    help="当前平台无 pty 时判失败（CI 用，防静默跳过）")
    args = ap.parse_args()

    xtc = os.path.abspath(args.xtc)
    if not os.path.exists(xtc):
        if args.require_pty:
            return fail("找不到编译器 %s" % xtc)
        print("SKIP：找不到编译器 %s（Unix 上需先跑自举链得到 build/xtc_s4.exe）" % xtc)
        return 0

    exe = build_example(xtc)
    if exe is None:
        return 2

    if not IS_UNIX:
        msg = "当前平台 %s 无 Unix pty，跳过交互测试（Windows 交互路径由运行时 ReadConsoleInputW 后端负责）" % sys.platform
        if args.require_pty:
            return fail(msg)
        print("SKIP：%s" % msg)
        return 0

    text, rc = run_under_pty(exe)
    if text is None:
        return 1

    failed = [c for c in CHECKS if c not in text]
    for c in CHECKS:
        print(("✅" if c not in failed else "❌"), repr(c))
    exit_ok = (rc == 0)
    print(("✅" if exit_ok else "❌"), "进程正常退出（退出码=%s）" % rc)
    if not exit_ok:
        failed.append("进程正常退出")
    print("总计:", "全过" if not failed else "失败项 %s" % failed)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
