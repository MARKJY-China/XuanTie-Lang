# 测试目录说明

本目录只放**仓库内可复现**的库级测试（Python 标准库实现），CI 与本地都可跑。
应用侧的集成测试不进本目录（见文末）。

## 测试清单

| 文件 | 平台 | 内容 |
|---|---|---|
| `示例驱动.py` | Unix（Linux/macOS）pty | 编译 `../示例.xt` 后用 pty 驱动，8 项断言：普通键（码=97）/ 方向键上（码=1001）/ SGR 左键按下（按钮=0 动作=按下）/ 滚轮上（按钮=64 动作=上滚）/ 孤 ESC（码=27）/ 退出恢复序列（ESC[?1049l） |
| `C1读字节超时.py` + `C1读字节超时.xt` | Unix（Linux/macOS）pty | 契约 C1 回归：`句柄.读字节(n)` 在 VTIME 超时、无数据可读时返回**成功且空串**（`.成功 == 真`、`.值 == ""`），连续 3 轮新开句柄验证；同时实际走 C2 的 `文件.打开("/dev/tty","读")` 路径 |
| `编译冒烟.py` | Windows / Linux / macOS | 不运行 TUI：`字符流.xt` `-jc` 检查 + `-lib` 库对象 + `示例.xt` `-sc` 编译链接（覆盖库 import → runtime .o → gcc/clang 链接全链） |

## 运行方式（在仓库根目录）

```bash
# Unix（Linux/macOS）：编译器路径按需替换（CI 用自举链顶 build/xtc_s4.exe）
python3 lib/字符流/测试/编译冒烟.py   --xtc build/xtc_s4.exe
python3 lib/字符流/测试/示例驱动.py   --xtc build/xtc_s4.exe
python3 lib/字符流/测试/C1读字节超时.py --xtc build/xtc_s4.exe

# Windows：pty 用例只做编译冒烟后明确 SKIP；编译门禁可在 CI/本地跑
python  lib/字符流/测试/编译冒烟.py   --xtc build/xtc_s4.exe
```

- `--xtc`：指定编译器（缺省 `build/xtc_s4.exe`）；两个 pty 用例在无 pty 的平台
  默认跳过、加 `--require-pty` 则把跳过判为失败（CI 用，防静默跳过）。
- 两个 pty 用例自带编译步骤（临时构建目录 `temp/lib_charstream_pty/`、
  `temp/lib_charstream_c1/`，ASCII 产物名——Windows/MinGW 窄字符路径打不开中文
  产物名），不要求手工先编好示例。
- Unix pty 用例的关键：`setsid` + `TIOCSCTTY` 设控制终端（`/dev/tty` 可打开、
  库才会走轮询模式）；C1 用例同时把终端设成 raw + `VMIN=0 / VTIME=1`。
- Windows 无 Unix pty：Windows 交互路径由运行时 ReadConsoleInputW 控制台后端
  提供，真实控制台验收需人工在 Windows Terminal 完成（见 支持矩阵.md §6）。

## 环境依赖

- python3 标准库（`pty`/`fcntl`/`termios` 仅 Unix；脚本在 Windows 上可导入，
  走 SKIP 分支）
- 玄铁自举编译器（`build/xtc_s4.exe`，由 `tools/bootstrap_check.sh` 产出）
- 运行时依赖契约 C1–C5 见 `../接口设计.md` §6

## 应用集成测试归档说明

`tui_pty_test.py` / `tui_mouse_check.py` / `tui_idle_refresh_check.py` /
`tui_selection_follow_check.py` 曾是 music-sort 应用仓库的集成级回归（14 项套件
+ 三专项），硬编码作者机器与应用仓库路径，**在官方库中不可复现**，已从本目录
删除；它们保留在 music-sort 应用仓库 `scripts/python/` 作为真机验证记录。
本库的"声明=测过"由上面三个可复现用例 + CI 门禁承担。
