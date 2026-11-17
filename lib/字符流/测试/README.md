# 测试目录说明

## 已验证的测试资产（2026-11-17 随库初始状态）

- **示例驱动.py**：pty 驱动 `示例.xt` 编译产物，验证库的全事件形态——
  普通键/方向键/SGR 点击/滚轮/孤 ESC/退出恢复 8 项断言。**库级测试**，
  与应用无关，`python3 测试/示例驱动.py` 即可跑。
- **tui_pty_test.py / tui_mouse_check.py / tui_idle_refresh_check.py /
  tui_selection_follow_check.py**：music-sort 应用的集成级回归（14 项套件
  + 三专项），验证本库代码在真实应用中的行为。它们引用应用仓库的构建
  与测试树，**在本目录只是存档**——运行需回应用仓库
  （/Users/user2/Documents/Code.localized/xuantie-music-sort）`scripts/python/`。

## 为什么集成测试也随库走

库的每个函数都先在应用内真机验证、再萃取成库；集成测试是"验证记录"的
可执行形态——"声明 = 测过"原则要求测试在场。向上游提 PR 时，若维护方
要求独立的库级测试套件，以 示例驱动.py 的驱动模式为模板扩展（setsid +
TIOCSCTTY 设控制终端是 pty 驱动的关键，见 示例驱动.py 注释）。

## 环境依赖

- python3 标准库 pty/fcntl/termios —— Unix 专属，Windows 不适用
- 玄铁运行时 26.11.3+（语义契约见 接口设计.md §6）
