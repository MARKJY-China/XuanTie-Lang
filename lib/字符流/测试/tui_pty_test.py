#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TUI 无头自动化验收(pseudo-terminal)。

不依赖真终端/人工,在脚本内完成:整树测试副本构建 → pty 启动 TUI →
注入键序列(方向键/回车/空格/s/m/滚轮/q)→ 断言媒体桥状态文件 → 清理。

用法:
    python3 scripts/python/tui_pty_test.py                # 全流程(含测试副本构建)
    python3 scripts/python/tui_pty_test.py --skip-build   # 跳过构建(已有测试二进制)
    uv run scripts/python/tui_pty_test.py                 # 用 uv 跑也行(仅标准库)

依赖:仅 Python 标准库(pty/select/subprocess),哪个解释器跑都一样。
"""

import argparse
import fcntl
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import sys
import termios
import threading
import time

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
XTC = pathlib.Path.home() / "Library/Caches/xtl/core/darwin-arm64/xtc-package/xtc"
TEST_ROOT = pathlib.Path("/private/tmp/xt-ms-e2e")
SRC_T = TEST_ROOT / "src-t"
TEST_BIN = TEST_ROOT / "music-sort-test"
LIB_DIR = TEST_ROOT / "library3"
STUB = TEST_ROOT / "stub-player"

PASS = []
FAIL = []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  ({detail})" if detail else ""))


def make_test_tree():
    """整树测试副本:源码拷到 /tmp 并把扫描源指向测试素材。
    教训:必须整树复制——单拷主文件会让模块 引 解析失败;
    且每次源码改动后必须重建,旧二进制会造成「时好时坏」的假象。"""
    if SRC_T.exists():
        shutil.rmtree(SRC_T)
    shutil.copytree(REPO / "src", SRC_T)
    scan = SRC_T / "扫描.xt"
    t = scan.read_text()
    lines = t.split("\n".replace("\n", "\n"))
    # 按内容定位 源列表 常量块并替换
    i0 = next(i for i, l in enumerate(lines) if l.startswith("设 源列表"))
    i1 = next(i for i, l in enumerate(lines) if i > i0 and l.strip() == "]")
    lines[i0:i1 + 1] = ['设 源列表 = [["test-a", "%s"]]' % (LIB_DIR / "src1")]
    scan.write_text("\n".join(lines))


def build():
    # 哑播放器:立即退出(不发声;暂停断言走 30s 真素材)
    STUB.write_text("#!/bin/sh\necho \"stub: $*\"\nexit 0\n")
    STUB.chmod(0o755)
    r = subprocess.run([str(XTC), "tie", "音乐排序.xt", "-sc", str(TEST_BIN),
                        "-pt", "darwin", "-jg", "arm64"], cwd=SRC_T, capture_output=True)
    if r.returncode != 0:
        print(r.stdout.decode()[-2000:], r.stderr.decode()[-2000:])
        raise SystemExit("测试二进制构建失败")
    shutil.copy(REPO / "媒体桥", TEST_ROOT / "媒体桥")


class TUI:
    """pty 里的 TUI 会话。要点:后台线程持续读 pty——
    macOS pty 输出缓冲只有 ~2KB,不读的话 TUI 写第二帧就阻塞在 write,
    样本里表现为 100% 卡在 write,看起来像程序卡死(实为测试方法缺陷)。"""

    def __init__(self, cols=24, rows=80, player=None):
        self.bridge_dir = pathlib.Path(f"/private/tmp/媒体桥-测试-{time.time_ns()}")   # 命名带"测试",与人类会话目录一眼可辨
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", cols, rows, 0, 0))
        player_args = [str(TEST_BIN), "tui", "--player", player or str(STUB),
                       "--桥目录", str(self.bridge_dir)]

        def _make_ctty():
            # 把 slave 设为子进程控制终端:/dev/tty 轮询读键依赖它(2026-11-08)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(
            player_args,
            stdin=slave, stdout=slave, stderr=slave,
            cwd=str(LIB_DIR), close_fds=True, preexec_fn=_make_ctty)
        self.alive = [True]
        threading.Thread(target=self._reader, daemon=True).start()
        time.sleep(1.2)

    def _reader(self):
        while self.alive[0]:
            r, _, _ = select.select([self.master], [], [], 0.1)
            if r:
                try:
                    os.read(self.master, 65536)
                except OSError:
                    break

    def send(self, data, wait=0.4):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())
        time.sleep(wait)

    def bridge_status(self):
        # 每实例唯一协议目录(--桥目录 传入,确定性)
        return self.bridge_dir / "状态"

    def status(self):
        p = self.bridge_status()
        try:
            return dict(l.split("=", 1) for l in p.read_text().splitlines() if "=" in l)
        except Exception:
            return {}

    def log_tail(self, n=4):
        p = self.bridge_status().parent / "媒体桥日志"
        try:
            return p.read_text().splitlines()[-n:]
        except Exception:
            return []

    def close(self):
        self.alive[0] = False
        time.sleep(0.2)
        self.proc.kill()


def wait_status(tui, key, want, timeout=2.5):
    """状态转换断言用轮询:最长等 timeout 秒,状态出现即过(消除固定 sleep 的竞态)。"""
    end = time.time() + timeout
    while time.time() < end:
        if tui.status().get(key) == want:
            return True
        time.sleep(0.1)
    return tui.status().get(key) == want


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-build", action="store_true")
    args = ap.parse_args()

    print("== 准备 ==")
    # 清残留进程(上轮测试的 TUI/媒体桥)
    subprocess.run(["pkill", "-f", str(TEST_BIN)], capture_output=True)
    subprocess.run(["pkill", "-f", "媒体桥"], capture_output=True)
    time.sleep(0.3)
    if not args.skip_build:
        make_test_tree()
        build()
    else:
        assert TEST_BIN.exists(), "测试二进制不存在,先去掉 --skip-build"

    # 测试库:素材 → scan 入库(scan 本身也是被测功能)
    if LIB_DIR.exists():
        shutil.rmtree(LIB_DIR)
    LIB_DIR.mkdir(parents=True, exist_ok=True)
    src1 = LIB_DIR / "src1"
    src1.mkdir(parents=True, exist_ok=True)
    for artist, title in [("Artist One", "Song A"), ("Test Band", "另一首歌"),
                          ("Test Band", "短音"), ("周杰伦", "晴天")]:
        safe = (f"{artist} - {title}.mp3").replace("/", "_")
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
                        "-codec:a", "libmp3lame", "-q:a", "9", str(src1 / safe)],
                       capture_output=True)
    r = subprocess.run([str(TEST_BIN), "scan"], cwd=str(LIB_DIR), capture_output=True)
    check("scan 入库", r.returncode == 0)
    check("scan 后 metadata.json 存在", (LIB_DIR / "metadata.json").exists())


    print("== 会话 1:行为序列 ==")
    tui = TUI(player="afplay -v 0")      # 静音真播放:暂停断言需真进程(哑播放器秒退会连播竞态)
    time.sleep(0.4)
    check("进入待命(不自动播放)", tui.status().get("播放中") == "0")

    tui.send("\r")                       # 回车:播放选中
    check("回车后 播放中=1", wait_status(tui, "播放中", "1"))

    tui.send(" ")                        # 空格:暂停
    check("空格后 已暂停=1", wait_status(tui, "已暂停", "1"))

    tui.send(" ")                        # 空格:恢复
    check("再空格后 已暂停=0", wait_status(tui, "已暂停", "0"))

    tui.send("\x1b[B")                   # 方向键↓:高亮移动(不换曲)
    time.sleep(0.4)
    check("方向键↓ 后 索引仍可读", "索引" in tui.status())

    tui.send("n")                        # 下一首(媒体桥换曲)
    time.sleep(0.6)
    check("n 触发媒体桥起播", any("起播" in l for l in tui.log_tail(6)))

    tui.send("s")                        # 停止
    check("s 后 播放中=0", wait_status(tui, "播放中", "0"))

    tui.send("m")                        # m:左键开关(内部状态)
    time.sleep(0.3)
    # 两段式点击:首次点第 0 行(与当前选中不同则仅选中),第二次同行点击才起播。
    # 断言走状态文件——此前断言 log 含"起播"被更早的 n 键日志污染,是假通过(2026-11-08)。
    tui.send("\x1b[<0;10;3M")            # SGR 左键按下(y=3 → 列表第 0 行)
    time.sleep(0.3)
    tui.send("\x1b[<0;10;3m")            # 释放
    time.sleep(0.4)
    tui.send("\x1b[<0;10;3M")            # 同行第二次按下 → 触发播放
    time.sleep(0.3)
    tui.send("\x1b[<0;10;3m")
    check("点击同行两次触发起播", wait_status(tui, "播放中", "1"))
    check("点击播放的是第 0 行", tui.status().get("索引") == "0")

    tui.send("\x03")                     # Ctrl+C 退出(退出键只认 Ctrl+C,q 已非退出键)
    time.sleep(0.6)
    tui.close()

    print("== 会话 2:跨会话残留 ==")
    tui2 = TUI()
    time.sleep(0.4)
    check("重进后 播放中=0(无残留)", tui2.status().get("播放中") == "0")
    check("重进后 索引=0(高亮第一首)", tui2.status().get("索引") == "0")
    pg = subprocess.run(["pgrep", "-x", "媒体桥"], capture_output=True)
    check("新媒体桥存活", bool(pg.stdout.strip()))
    tui2.send("\x03")
    time.sleep(0.6)
    tui2.close()

    print("== 汇总 ==")
    print(f"通过 {len(PASS)} / 失败 {len(FAIL)}")
    if FAIL:
        print("失败项:", FAIL)
        raise SystemExit(1)
    print("全部通过")


if __name__ == "__main__":
    main()
