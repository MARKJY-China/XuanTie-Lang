#!/usr/bin/env python3
"""选中不跟随播放专项验证:回车起播第 0 行后,模拟自动切歌(外部写 next),
断言 ① 桥切到第 1 首 ② 选中高亮仍停在第 0 行(Song A) ③ 头栏显示新歌名。"""
import os, re, select, sys, time, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import tui_pty_test as t

t.build()
t.make_test_tree()
# 30 秒 stub:防止哑播放器秒退引发连播竞态
t.STUB.write_text("#!/bin/sh\nsleep 30\n")
t.STUB.chmod(0o755)

tui = t.TUI(player=None)
master = tui.master
tui.send("\r", wait=1.0)          # 回车起播第 0 行(Song A)

# 关掉套件读线程,由主线程收输出(避免双读者竞态)
tui.alive[0] = False
time.sleep(0.3)

def collect(sec):
    buf = b""
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                buf += os.read(master, 65536)
            except OSError:
                break
    return buf.decode("utf-8", "replace")

def last_frame(text):
    chunks = text.split("\x1b[H")
    return chunks[-2] if len(chunks) >= 2 else chunks[-1]

def sel_blocks(frame):
    # 选中行=蓝底(48;5;24);头栏同为蓝底但必是首个块,跳过
    return re.findall(r"\x1b\[48;5;24m(.*?)\x1b\[0m", frame, re.S)[1:]

def sel_has(frame, needle):
    return any(needle in b for b in sel_blocks(frame))

# 基线:起播后选中应为第 0 行
base = last_frame(collect(1.0))
base_ok = sel_has(base, "Song A")
print("起播后选中含 Song A:", base_ok)

# 模拟自动切歌:直接向桥写 next(与连播/媒体键同一条推进路径)
(tui.bridge_dir / "命令").write_text("next")
after = collect(2.0)
st = tui.status()
print("桥状态: 索引=%s 播放中=%s" % (st.get("索引"), st.get("播放中")))

frame = last_frame(after)
sel_a = sel_has(frame, "Song A")
sel_b = sel_has(frame, "另一首歌")
print("切歌后反显块: Song A=%s 另一首歌=%s" % (sel_a, sel_b))
print("头栏含新歌名:", "另一首歌" in frame)

ok1 = base_ok
ok2 = st.get("索引") == "1"
ok3 = sel_a
ok4 = "另一首歌" in frame and not sel_b
allok = ok1 and ok2 and ok3 and ok4
print("判定:", "✅ 通过(自动切歌不动选中)" if allok
      else "❌ 失败[基线选中=%s 桥索引=%s 切后选中SongA=%s 高亮跟随=%s]" % (ok1, ok2, ok3, sel_b))
tui.proc.kill()
sys.exit(0 if allok else 1)
