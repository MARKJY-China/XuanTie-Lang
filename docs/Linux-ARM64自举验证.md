# Linux ARM64 自举验证（GNU/Linux AArch64 Bootstrap）

> 本文记录玄铁在 GNU/Linux（aarch64 / ARM64）上完成自身自举的验证过程与结论。
> 对应 issue #18（缺 -lm）与 PR #19（修复）的实证背景。

## 1. 验证环境

| 项 | 值 |
|----|----|
| 系统 | Debian 13 (trixie)，aarch64 |
| 虚拟化 | QEMU/HVF（宿主 macOS M 系列），8 vCPU |
| Go | 1.26.5 linux/arm64（官方源码分发，解压即用） |
| C 工具链 | clang 19 + gcc 14（apt 安装） |

## 2. 自举链实测闭环

```
GSC（Go 种子编译器）→ 编译 xuantie_compiler/玄铁.xt → s1（ELF aarch64）
s1 → 编译 hello.xt → 可执行，运行输出「你好，玄铁 ARM64！ 1+1=2」
s1 → 编译 玄铁.xt（自身源码）→ s1_2（ELF aarch64，约 2.3MB）
```

即：**种子编译器 → s1 → 应用 → s1_2**，全链在 Linux ARM64 上成立。
验证细节：`go build` 产出 GSC（BUILD_OK）→ `xtc tie 玄铁.xt`（TIE_RC=0）→ 产物 `file` 确认为 ELF aarch64 → hello 程序编译、链接、运行正确 → s1 编译自身源码产出 s1_2。

## 3. 关键问题：缺 -lm（issue #18 / PR #19）

- **现象**：Linux 上编译普通（非渲染）程序，链接阶段报数学函数 `undefined reference`（pow/sin/cos/sqrt，运行时 `xt_math_*` 使用）。
- **根因**：darwin 的 libSystem 自带数学库，macOS 上不暴露；MinGW 也不需要；而 Linux 的 libm 需要显式 `-lm` 链接。玄铁.xt 的链接指令此前只在渲染分支带 `-lm`，非渲染分支遗漏。
- **误导**：链接失败时打印的「MinGW 链接失败」文案在 POSIX 平台也出现（玄铁.xt 注释已自承该文案误导）。
- **修复**：posix 非渲染链接指令对 linux 追加 `-lm -lpthread -ldl`（玄铁.xt 与 编译.xt 两处）——PR #19 已合并（6a22c1c）。
- **实证**：修复前链接失败；修复后全链通过。该 bug 只能在 Linux 侧复现（macOS 被 libSystem 掩盖）。

## 4. 环境依赖（Linux 特有）

- **clang**：tie 的 LLVM 后端发射后调用 clang 完成汇编/链接。macOS 自带 clang（Xcode 命令行工具），Linux 需 `apt install clang`。
  若 Linux 上 tie 报 `exec: "clang": executable file not found in $PATH`，即缺 clang——属环境问题，非代码问题。
- **gcc**：玄铁运行时 C 代码编译所需（clang 亦可，gcc 为系统默认）。

## 5. 遗留

- 按 AGENTS.md 自举分级规矩，s1→s4 逐字节比对 + 各级哈希报告未做（本验证到 s1_2 为止）。
- 仅覆盖 aarch64；Intel（x86_64）等其他架构不在本次验证范围。
