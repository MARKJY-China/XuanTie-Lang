# 字符流 changelog

## v0.1.0（2026-11-18）

首版。萃取自 music-sort 真机 TUI（2026-11-07~08 密集真机调试沉淀），
Unix 与 Windows 双后端、测试与契约随首发一次落地。

**首版（2026-11-17 萃取）**

- tty 模式管理（进原始模式/恢复终端，轮询 + 阻塞双模式）
- tty 轮询读键（/dev/tty 句柄常驻 + 空读即弃）
- 取事件统一入口（键 + SGR 鼠标 + X10 鼠标 + 空转心跳 + 终端断开）
- 转义序列原语（取转义/前色/背色）
- 坑文档与支持声明随库走（支持矩阵.md、接口设计.md）

**Windows 支持（同版首发，不单独升版本）**

- 运行时新增 ReadConsoleInputW 控制台事件后端（不依赖 ConPTY、不起子进程）；
  库按 `系统.操作系统类别()` 分支，Windows 侧经 `xt_tui_enter` /
  `xt_tui_leave` / `xt_tui_read_n` 桥读键。运行时把控制台 KEY_EVENT/MOUSE_EVENT
  翻译成与 Unix 相同的 VT 字节流，库内解析器原样复用。
- Windows 键鼠事件形态与 Unix 一致（方向键 1001–1004、SGR 1006 鼠标语义、
  滚轮按钮 64/65）；Ctrl+C 按原始字节 3 上报、不触发控制台信号。
- 恢复终端顺序：先输出恢复序列、再 `xt_tui_leave()` 关 VTP（`xt_tui_leave`
  内部先 `fflush(stdout)` 再还原输出模式），反序会让 ESC 变字面乱码。
- 支持口径：Windows Terminal（Win11 内置 / Win10 1903+ 手装），不做 winpty
  兼容层，裸旧 conhost 明确不支持（详见 支持矩阵.md §3/§6）。Windows 后端
  已过编译门禁、无控制台回退与白盒翻译探针；**真实控制台 TUI 交互待人工在
  Windows Terminal 验收**（按「声明=测过」，未验收前不写"全功能已支持"）。
- Unix 侧行为不变（C1–C4 契约与既有用例保持）。

**测试与契约**

- 新增可复现的库级测试（`测试/`，只依赖 Python 标准库）：
  - `示例驱动.py`：pty 驱动 `示例.xt` 编译产物，8 项断言覆盖普通键/方向键/
    SGR 点击/滚轮/孤 ESC/退出恢复（Unix：Linux/macOS）；
  - `C1读字节超时.py` + `C1读字节超时.xt`：契约 C1 回归——3 轮 VTIME 超时读
    必须返回「成功且空串」（Unix：Linux/macOS）；
  - `编译冒烟.py`：`字符流.xt` `-jc` 检查 + `-lib` 库对象 + `示例.xt` `-sc`
    编译链接，Windows/Linux/macOS 通用、不运行 TUI。
- 删除随 PR 存档的 music-sort 应用集成测试（`tui_pty_test.py` 与
  鼠标/空闲刷新/选中跟随三专项）：它们硬编码应用仓库路径，在官方库不可复现，
  归档回 music-sort 应用仓库 `scripts/python/`（测试/README.md 说明）。
- C1–C4 运行时依赖契约正式化：C1（`句柄.读字节` 超时返回成功且空串）写入
  `GUIDE/关键字/文件.md` 并配 pty 回归；C2（`文件.打开` 的「读」模式与结果
  形态）引用 `GUIDE/关键字/文件.md`；C3（`时.毫秒`/`时.微秒`）引用
  `GUIDE/关键字/时.md`；C4（Unix tty/stty/POSIX 约定）写入 支持矩阵.md；
  Windows 分支运行时桥记为新增 C5（接口设计.md §6）。
- 版本登记进 `xt-ecosystem/contracts/lib-version-discipline`：tiepm.toml /
  源文件头 / changelog 三处均为 `0.1.0`（`headerRequired=true`）。
- CI（`.github/workflows/ci.yml`）：Windows gate 增 `编译冒烟.py`（含 Windows
  控制台后端编译链接）；Linux/darwin gate 增 `示例驱动.py`、`C1读字节超时.py`
  （`--require-pty`，禁止静默跳过）。
- 已知限制（不变）：X10 鼠标路径未真机验证（实验性）；显示宽/裁宽不在库内；
  Windows 无 resize 事件 API（详见 接口设计.md §7、支持矩阵.md §6）。
