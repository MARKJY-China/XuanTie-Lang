#!/usr/bin/env python3
"""鼠标专项验证:还原 WezTerm 真实发送形态,断言滚轮滚动与两段式点击。

背景(2026-11-08 鼠标回归):tty 轮询取键若每次新开 /dev/tty 句柄,stdio 缓冲
会把整段多字节序列预读后随句柄关闭丢弃,鼠标/方向键只剩孤 ESC。修复为常驻
句柄+空读即弃后,本脚本作回归哨兵。

注意:测试库仅 4 首,故用 6 行小屏让列表可滚(列表区 3 行);SGR 按钮码
64=滚轮上 65=滚轮下(xterm 惯例)。"""
import os, re, select, sys, time, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import tui_pty_test as t

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  ({detail})" if detail else ""))


t.make_test_tree()
t.build()
t.STUB.write_text("#!/bin/sh\nsleep 30\n")
t.STUB.chmod(0o755)

tui = t.TUI(player=None, cols=6, rows=100)   # 6 行屏:列表区 3 行 < 4 首,滚轮有空间;100 列容纳状态栏全文字
tui.alive[0] = False
time.sleep(0.3)


def collect(sec):
    buf = b""
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([tui.master], [], [], 0.1)
        if r:
            try:
                buf += os.read(tui.master, 65536)
            except OSError:
                break
    return buf.decode("utf-8", "replace")


def last_frame(text):
    chunks = text.split("\x1b[H")
    return chunks[-2] if len(chunks) >= 2 else chunks[-1]


def sel_songs(frame):
    # 选中行=蓝底(48;5;24);头栏同为蓝底但必是首个块,跳过
    return re.findall(r"\x1b\[48;5;24m(.*?)\x1b\[0m", frame, re.S)[1:]


def has(frame, needle):
    return any(needle in b for b in sel_songs(frame))


check("基线选中第 0 首", has(last_frame(collect(0.8)), "Song A"))

tui.send("m", wait=0.3)
check("m 开鼠标模式", "左键:开" in last_frame(collect(0.8)))

# 滚轮下(65)×2:选中应随视口下移(每步 max(2, 列表行数/4)=2,钳制)
for _ in range(2):
    tui.send("\x1b[<65;30;5M", wait=0.15)
check("滚轮下 ×2 选中下移", has(last_frame(collect(1.0)), "另一首歌"))

# 滚轮上(64)×9:回滚到顶,选中钳回第 0 首
for _ in range(9):
    tui.send("\x1b[<64;30;5M", wait=0.15)
check("滚轮上 ×9 回到顶", has(last_frame(collect(1.0)), "Song A"))

# 两段式点击第 1 行(y=4 → 列表第 1 行):首击选中,再击起播
tui.send("\x1b[<0;500;4M", wait=0.05)
tui.send("\x1b[<0;500;4m", wait=0.5)
check("点击选中第 1 行", has(last_frame(collect(0.8)), "另一首歌"))
tui.send("\x1b[<0;500;4M", wait=0.05)
tui.send("\x1b[<0;500;4m", wait=0.6)
st = tui.status()
check("同行再击起播", st.get("播放中") == "1" and st.get("索引") == "1", str(st))

# 按下/释放拆开发送 + 大坐标(宽 500 列):序列应完整解析不粘连(点击仅选中第 0 行)
tui.send("\x1b[<0;500;3M", wait=0.05)
tui.send("\x1b[<0;500;3m", wait=0.5)
check("大坐标+分离按压解析正常", has(last_frame(collect(0.8)), "Song A"))

print(f"== 鼠标专项:通过 {len(PASS)} / 失败 {len(FAIL)} ==")
if FAIL:
    print("失败项:", FAIL)
    tui.proc.kill()
    raise SystemExit(1)
tui.proc.kill()
print("全部通过")
