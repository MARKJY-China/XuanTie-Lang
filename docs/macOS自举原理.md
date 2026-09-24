# macOS 自举原理（macOS Bootstrap）

> 本文记录让玄铁在 macOS（Apple Silicon / arm64）上完成自身自举的原理与改造面。
> **Intel Mac（x86_64）明确不支持**：Intel Mac 为多年前的过时平台，无维护价值。
> 对应踩坑细节见《macOS自举踩坑记录.md》。

## 1. 自举链全景

作者在群里给出的链（Windows 侧）为：

```
Go 写的玄铁解释器 → Go 写的玄铁转译器 → Go 写的玄铁编译器（种子编译器）
→ 玄铁种子编译器（Go Seed Compiler）编译出的玄铁自举编译器（s1）
→ s1 编译自身源码 → 应用；C 是玄铁运行时
```

macOS 侧的目标是让这条链在 Mac 上原样成立。实测闭环（本机 arm64）：

```
build/xtc（Go 种子编译器）→ 编译 xuantie_compiler/玄铁.xt → s1（arm64 Mach-O）
s1 → 编译 玄铁.xt（自身源码）→ s1_2（第二代，约 10s）
s1_2 → 编译 hello.xt → 可执行，运行正确
```

即：**种子编译器 → s1 → s1_2 → 应用**，三代全部在 macOS 上编译并运行。

## 2. 改造面总览

| 层 | 文件 | 内容 |
|----|------|------|
| Go 种子编译器 | `compiler/llvm.go` | `TargetTriple()` / `TargetDataLayout()` 按目标平台返回 LLVM 目标 |
| Go 种子编译器 | `main.go` | tie/zao 默认取 `runtime.GOOS/GOARCH`；链接参数按平台分支；`findCCompiler()`；raylib 目录与 runtime 目录平台化 |
| Go 种子编译器 | `compiler/compiler.go` | 转译器 FFI 按目标平台发射（非 Windows 发射"暂不支持"存根） |
| Go 种子编译器 | `evaluator/ffi_other.go` / `ffi_windows.go`、`term_other.go` / `term_windows.go` | 平台拆分：`syscall.LoadDLL` / 终端虚拟处理仅限 Windows 构建 |
| C 运行时 | `runtime/xt_runtime.h` / `xt_runtime.c` / `xt_net.c` / `xt_threadpool.c` / `xt_tls.c` | POSIX 线程宏、macOS 进程路径、POSIX 通道等待、TLS 存根 |
| 玄铁自举编译器 | `xuantie_compiler/玄铁.xt` | 平台/架构自动探测、路径分隔符、目标三元组、链接与清理命令平台分支 |
| 玄铁自举编译器 | `xuantie_compiler/编译.xt` | 编译器对象平台/架构字段、IR 头 triple/layout 平台化、路径规范化 POSIX |

## 3. 关键机制

### 3.1 平台 / 架构自动探测（玄铁.xt）

`--平台` / `--架构` 未显式指定时：

- 平台：`执("uname -s")` → `Darwin` ⇒ darwin；`Linux` ⇒ linux；探测失败回退 windows（历史行为）。
- 架构：`执("uname -m")` → `arm64/aarch64` ⇒ arm64；`x86_64/amd64` ⇒ amd64；失败回退 amd64。

### 3.2 目标三元组（平台化后）

| 平台 | 架构 | 三元组 |
|------|------|--------|
| windows | amd64 | `x86_64-w64-windows-gnu` |
| darwin | arm64 | `arm64-apple-darwin` |
| darwin | amd64 | `x86_64-apple-darwin`（仅保留探测分支；**不支持**，Intel Mac 为过时平台） |
| linux | amd64 | `x86_64-linux-gnu` |
| linux | arm64 | `aarch64-linux-gnu` |

种子编译器（`llvm.go`）与自举编译器（`编译.xt` 的 `平台三元组()` / `平台布局()`）分别实现同一张表，保证 IR 头一致。

### 3.3 链接参数平台分支

- Windows：保留 `-static -Wl,--stack -Wl,--no-insert-timestamp -mwindows -lws2_32 -lsecur32`，渲染加 `-lopengl32 -lgdi32 -lwinmm -limm32`。
- darwin：无 Windows 系统库；渲染加 `-framework Cocoa -framework OpenGL -framework IOKit -framework CoreVideo`。
- linux：渲染加 `-lGL -lm -lpthread -ldl -lrt -lX11`。
- 清理/复制命令：Windows `cmd /c del|copy`，POSIX `rm -f` / `cp -f`（`玄铁.xt` 新增 `删文件` / `复制文件` 辅助函数）。

### 3.4 运行时定位

编译器按**自身二进制目录**（`xt_self_path()`，macOS 用 `_NSGetExecutablePath` + `realpath`）解析 `runtime/`、`lib/`、`tools/`：

```
自身目录/runtime/xt_runtime.c
自身目录/../runtime/xt_runtime.c
当前目录 runtime/…、../runtime/…
```

因此把编译器二进制放在仓库 `build/` 下即可通过 `../runtime` 找到运行时。

### 3.5 IR 头平台化

`编译.xt` 原先硬编码 `target triple = "x86_64-w64-windows-gnu"` 与 Windows datalayout；现由 `平台三元组()` / `平台布局()` 按编译器对象的 `平台/架构` 字段生成（字段由 `玄铁.xt` 在 `设 编译 = 造 编译器()` 后注入）。

## 4. 复现步骤（arm64 macOS）

```bash
# 1) 构建 Go 种子编译器
go build -o build/xtc .

# 2) 生成第一代 s1（种子编译器编译玄铁.xt；产物为 CWD 下 ./玄铁）
./build/xtc tie xuantie_compiler/玄铁.xt
mv 玄铁 build/s1

# 3) 第二代：s1 编译自身源码
./build/s1 -sc build/s1_2 xuantie_compiler/玄铁.xt

# 4) 应用：s1_2 编译 hello
cd /tmp && ./<repo>/build/s1_2 hello.xt && ./hello
```

## 5. 回归

`s1` 编译并运行 `Test/` 下 117 个用例：113 个通过（含按设计报错的负向测试），1 个为长时间压力测试（有界、>60s、不崩溃），4 个渲染用例因 `渲染桥.c` 为 Win32 绑定（见踩坑记录 §7）未纳入。

## 6. 遗留

- Intel Mac（x86_64）明确不支持（过时平台，作者立场不维护）。
- 渲染桥 `lib/渲染/渲染桥.c` 为 Windows 深度绑定（`__declspec(dllimport)`、`MultiByteToWideChar`、`SetWindowPos/PostMessageW`），macOS 编译需 `#ifdef _WIN32` 守卫 + raylib 跨平台 API 映射。
- Windows 侧回归未在本次实测（改动均按平台分支保留原行为，风险低）。
- `findCCompiler()`（clang→gcc→cc）仅在本机 clang 环境验证；"仅装 gcc" 的模拟环境未测。
