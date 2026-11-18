#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# C1读字节超时.py —— 契约 C1 的 Unix pty 回归：句柄.读字节 超时空读返回「成功且空串」
#
# 契约 C1（正式文档见 GUIDE/关键字/文件.md「句柄.读字节」）：
#   在带读超时的终端上（VTIME 超时、无数据可读），句柄.读字节(n) 返回
#   Result.成功 == 真 且 Result.值 == ""，不是失败。只判 .成功 的代码会永不关闭
#   空读句柄、粘性 EOF 吞掉后续全部输入（真机实撞过的坑）。
#
# 本脚本做的事：
#   1. 用给定编译器把 测试/C1读字节超时.xt 编译成可执行文件；
#   2. 在 Unix pty 里 fork 子进程：setsid + TIOCSCTTY 设控制终端（/dev/tty 可打开的前提），
#      并把 stdin 终端设成 raw + VMIN=0 / VTIME=1（每 0.1s 超时一次），全程不发送任何输入字节；
#   3. 断言：退出码 0、输出含 C1_PASS、3 轮读确实各等了一次 VTIME（总耗时 ≥ 0.2s）。
#
# 平台口径：Unix（Linux/macOS）——CI 在这两个平台跑；Windows 无 Unix pty，只做 `-jc`
#   语法/语义检查后明确 SKIP（Windows 分支不走 /dev/tty + 句柄.读字节，见 支持矩阵.md）。
#
# 用法（仓库根目录）：
#   python3 lib/字符流/测试/C1读字节超时.py --xtc build/xtc_s4.exe
#   python3 lib/字符流/测试/C1读字节超时.py --xtc build/xtc_s4.exe --require-pty   # CI：禁止静默跳过
#
# 退出码：0 = C1 成立（或非 Unix 明确 SKIP）；1 = C1 被证伪/运行异常；2 = 编译/环境失败。
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
FIXTURE = os.path.join(HERE, "C1读字节超时.xt")
TMP = os.path.join(ROOT, "temp", "lib_charstream_c1")
IS_UNIX = (os.name == "posix")
VTIME_ROUNDS = 3          # 契约程序里 3 轮超时读
VTIME_UNIT = 0.1          # VTIME 单位 = 0.1s
# pty/fcntl/termios 仅 Unix 有：Windows 上允许本脚本被导入/运行（走「-jc 后 SKIP」分支），
# 故不放在文件顶部无条件 import。
if IS_UNIX:
    import fcntl
    import pty
    import termios


def build_fixture(xtc):
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)
    exe = os.path.join(TMP, "c1_timeout" + (".exe" if os.name == "nt" else ""))
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    try:
        r = subprocess.run([xtc, "铁", FIXTURE, "-sc", exe], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print("❌ 无法编译 C1 用例：%s" % exc)
        return None
    if r.returncode != 0 or not os.path.exists(exe):
        print("❌ C1 用例编译/链接失败（退出码 %d）：" % r.returncode)
        print((r.stdout or "") + (r.stderr or ""))
        return None
    print("C1 用例已编译：%s" % exe)
    return exe


def set_vtime_timeout(slave):
    """把 pty 从端设成 raw + VMIN=0 / VTIME=1（等价 stty raw -echo min 0 time 1）。"""
    attrs = termios.tcgetattr(slave)
    attrs[0] &= ~(termios.BRKINT | termios.ICRNL | termios.INPCK |
                  termios.ISTRIP | termios.IXON)          # iflag
    attrs[1] &= ~termios.OPOST                            # oflag
    attrs[2] |= termios.CS8                               # cflag
    attrs[3] &= ~(termios.ECHO | termios.ICANON |
                  termios.IEXTEN | termios.ISIG)          # lflag
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 1
    termios.tcsetattr(slave, termios.TCSANOW, attrs)


def run_under_pty(exe, timeout_s=20.0):
    """返回 (输出文本, 退出码, 墙钟耗时)；超时被杀时退出码为 -1。"""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    set_vtime_timeout(slave)   # pty 是设备级状态，fork 前设好子进程直接继承
    t0 = time.time()
    pid = os.fork()
    if pid == 0:  # 子进程
        try:
            os.close(master)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)   # 设控制终端（/dev/tty 才能打开）
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
    try:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    out.extend(chunk)
            wpid, st = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                status = st
                break
        # 子进程已退出，把 master 里剩余数据收干净（避免漏掉末尾输出）
        while True:
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

    elapsed = time.time() - t0
    if status is None:
        return bytes(out).decode("utf-8", "replace"), -1, elapsed
    code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
    return bytes(out).decode("utf-8", "replace"), code, elapsed


def main():
    ap = argparse.ArgumentParser(description="契约 C1：句柄.读字节 超时空读返回成功且空串")
    ap.add_argument("--xtc", default=os.path.join(ROOT, "build", "xtc_s4.exe"),
                    help="编译器路径（默认仓库 build/xtc_s4.exe）")
    ap.add_argument("--require-pty", action="store_true",
                    help="当前平台无 pty 时判失败（CI 用，防静默跳过）")
    args = ap.parse_args()

    xtc = os.path.abspath(args.xtc)
    if not os.path.exists(xtc):
        if args.require_pty:
            print("❌ 找不到编译器 %s" % xtc)
            return 2
        print("SKIP：找不到编译器 %s（Unix 上需先跑自举链得到 build/xtc_s4.exe）" % xtc)
        return 0

    if not IS_UNIX:
        # Windows：编译期检查仍可做（验证用例本身语义正确），交互断言跳过。
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        r = subprocess.run([xtc, "铁", FIXTURE, "-jc"], cwd=ROOT, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=300, env=env)
        if r.returncode != 0:
            print("❌ C1 用例 -jc 检查失败（退出码 %d）：" % r.returncode)
            print((r.stdout or "") + (r.stderr or ""))
            return 2
        msg = ("当前平台 %s 无 Unix pty，跳过 C1 交互断言（Windows 分支不走 "
               "/dev/tty + 句柄.读字节，见 lib/字符流/支持矩阵.md）" % sys.platform)
        if args.require_pty:
            print("❌ " + msg)
            return 2
        print("SKIP：%s" % msg)
        return 0

    exe = build_fixture(xtc)
    if exe is None:
        return 2

    text, code, elapsed = run_under_pty(exe)
    print("---- 被测程序输出 ----")
    print(text.rstrip())
    print("---- 结束（退出码=%s，耗时=%.2fs）----" % (code, elapsed))

    min_elapsed = VTIME_ROUNDS * VTIME_UNIT * 0.7   # 允许 30% 调度误差，低于此说明读没有真的超时
    failed = []
    if "C1_PASS" not in text:
        failed.append("未见 C1_PASS（契约不成立）")
    if code != 0:
        failed.append("退出码=%s（期望 0）" % code)
    if elapsed < min_elapsed:
        failed.append("总耗时 %.2fs 低于 %.1fs——读未按 VTIME 超时（或未设置 min 0 time 1）"
                      % (elapsed, min_elapsed))
    if failed:
        for f in failed:
            print("❌ " + f)
        print("C1 失败")
        return 1
    print("✅ C1 成立：3 轮 VTIME 超时读均返回 成功且空串（耗时 %.2fs）" % elapsed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
