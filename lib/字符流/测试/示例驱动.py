#!/usr/bin/env python3
# 示例驱动.py — pty 驱动 lib/字符流/示例.xt 编译产物，验证全事件形态
# 依赖：python3 标准库(pty/fcntl/termios)；Unix 专属。
# 用法：先 xtc tie 示例.xt -sc 字符流示例 -pt darwin -jg arm64，再 python3 测试/示例驱动.py
import os, sys, pty, select, time, fcntl, termios, struct

def main():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 6, 0, 0))
    pid = os.fork()
    if pid == 0:
        # setsid + 设控制终端：/dev/tty 才打得开(轮询模式的前提，套件同款)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
        os.close(master); os.close(slave)
        os.execv("./字符流示例", ["./字符流示例"])
    os.close(slave)

    all_out = b""
    def pump(sec):
        nonlocal all_out
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try: all_out += os.read(master, 65536)
                except OSError: break

    pump(0.7)
    os.write(master, b"a");      pump(0.4)   # 普通键 → 码=97
    os.write(master, b"\x1b[A"); pump(0.4)   # 方向键上 → 码=1001
    os.write(master, b"\x1b[<0;10;3M"); pump(0.4)   # SGR 左键按下 → 按钮=0 按下
    os.write(master, b"\x1b[<64;10;3M"); pump(0.4)  # SGR 滚轮上 → 按钮=64 上滚
    os.write(master, b"\x1b");   pump(0.4)   # 孤 ESC → 码=27
    os.write(master, b"\r");     pump(0.6)   # 退出 → 备用屏恢复序列
    pump(0.2)
    try: os.kill(pid, 9)
    except ProcessLookupError: pass

    text = all_out.decode("utf-8", "replace")
    checks = ["码=97", "码=1001", "按钮=0", "动作=按下", "按钮=64", "动作=上滚", "码=27", "\x1b[?1049l"]
    failed = [c for c in checks if c not in text]
    for c in checks:
        print(("✅" if c not in failed else "❌"), c)
    print("总计:", "全过" if not failed else f"失败 {failed}")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
