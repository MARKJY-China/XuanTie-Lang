#!/usr/bin/env python3
"""空闲自动刷新专项验证:起播后 3.2 秒内不发任何键,检查头栏分秒在输出帧里自动推进。"""
import os, re, select, sys, time, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import tui_pty_test as t

t.build()
t.make_test_tree()
# 用 30 秒 stub 替代秒退 stub:秒退会让桥无限连播,位置恒 0,无法验证分秒推进
t.STUB.write_text("#!/bin/sh\nsleep 30\n")
t.STUB.chmod(0o755)

frames = []
class Collector(tui_collector if False else object):
    pass

# 直接用套件的 TUI 类,但把读线程换成收集输出的版本
tui = t.TUI(player=None)
master = tui.master
# 关掉套件 reader 线程:双读者竞态会抢走输出帧,分秒采样随机缺帧(实测翻车)
tui.alive[0] = False
time.sleep(0.3)

buf = b""
end = time.time() + 6.0
tui.send("\r", wait=0.8)          # 回车起播
buf = b""
last = time.time()
while time.time() < end:
    r, _, _ = select.select([master], [], [], 0.1)
    if r:
        try:
            buf += os.read(master, 65536)
        except OSError:
            break

text = buf.decode("utf-8", "replace")
times = re.findall(r"\d{2}:\d{2}/\d{2}:\d{2}", text)
uniq = []
for x in times:
    if not uniq or uniq[-1] != x:
        uniq.append(x)
print("输出帧中出现过的 分秒/总秒 序列:", uniq)
ok = len(uniq) >= 3
print("自动刷新判定:", "✅ 通过(无输入分秒自动推进)" if ok else "❌ 失败(分秒没走,仍靠事件驱动)")
tui.alive[0] = False
tui.proc.kill()
sys.exit(0 if ok else 1)
