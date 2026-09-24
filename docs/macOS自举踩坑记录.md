# macOS 自举踩坑记录（Pitfalls）

> 本文记录 macOS 自举过程中踩过的坑与根因，供后续移植（Linux、Windows 回归）复用。
> 实测环境：Apple Silicon（arm64）。**Intel Mac（x86_64）不在支持范围**（过时平台，无维护价值）。
> 对应原理见《macOS自举原理.md》。

## 1. 玄铁语言语义陷阱（移植编译器必看）

### 1.1 `空 != ""`（空值不等于空串）

玄铁中 `空`（null）与 `""` 是两个值：`空 != ""` 为真。

坑：在 `编译.xt` 的 `路径分隔符()` 里最初用字段缓存 `若 此.路径分隔符缓存 != "" { 返 此.路径分隔符缓存 }` —— 字段初始为 `空` 时该判断为真，直接返回 `空`，下游 `路径.分割(分隔符)` 报

```
运行时错误: 对非字符串值调用字符串方法 '分割 分隔符'
```

修法：不要依赖空值判断做缓存，每次现算：

```
函 路径分隔符() {
    若 此.平台 != "windows" { 返 "/" }
    返 "\\"
}
```

### 1.2 `字符数`、`字节数`、`截取` 单位不一致

- `字符数`：按 Unicode 字符（"01_基础测试.xt" = 10）
- `字节数`：按 UTF-8 字节（同上 = 18）
- `截取(开始, 结束)`：**按字符**，且结束下标超过字符串长度时**钳位返回整串**（不报错）

坑：上游 `玄铁.xt` 默认输出名用 `路径.截取(0, 路径.字节数 - 3)`。ASCII 文件名（如 `hello.xt`）下字节==字符，恰好正确；**中文文件名**（`01_基础测试.xt`）下 `字节数-3` 超过字符数，截取返回整串 ⇒ **输出路径 == 源路径，编译产物直接覆盖源码**（源码变二进制，再编译时报"无法解析的 Token"）。Windows 侧被 `输出路径 = 路径.替换(".xt", ".exe")` 覆盖逻辑掩盖，从未暴露。

修法：统一按字符截取：

```
输出路径 = 路径.截取(0, 路径.字符数 - 3)   // 仅 Windows 再补 ".exe"
```

### 1.3 规范化绝对路径丢失前导分隔符

`规范化绝对路径()` 把路径按分隔符 `分割` 后跳过空段再 `连接`。POSIX 绝对路径以 `/` 开头，分割后首段为空，被跳过 ⇒ 结果 `Users/user2/…` 丢失前导 `/`，随后被二次拼接成双前缀路径（引入解析报"文件不存在"）。

修法：分割前记录首段是否为空，连接时补回前导分隔符。

## 2. 架构不探测 ⇒ 交叉链接失败

`玄铁.xt` 原默认 `架构 = "amd64"`。在 arm64 Mac 上未显式 `--架构` 时，三元组为 `x86_64-apple-darwin`，clang 产出 x86_64 目标文件，链接（默认 arm64）失败，报"MinGW 链接失败…状态码 256"（误导性：与 MinGW 无关）。

修法：与平台探测同套机制，`uname -m` 探测 `arm64/aarch64` / `x86_64/amd64`。

## 3. 链接参数硬编码 Windows 库（对应 issue #12）

`main.go` / `玄铁.xt` 原硬编码 `-lshell32 -lws2_32 -lsecur32 -lopengl32 -lgdi32 …`，macOS 链接报 `ld: library 'shell32' not found`。修法：链接参数按平台分支（见原理文档 §3.3）。

## 4. clang 硬编码（对应 issue #14）

`main.go` tie 模式硬编码 `exec.Command("clang", …)`，无 clang 环境直接 `exec: clang: executable file not found`。修法：新增 `findCCompiler()` 探测 `clang → gcc → cc`（注意：`gcc` 无法直接消费 LLVM IR，仅作为无 clang 时的更明确报错路径）。

## 5. 运行时布局约束

编译器按自身二进制目录找 `runtime/`。把 s1 复制到任意目录（如 `/tmp`）后编译会报：

```
错误: 未找到运行时文件(xt_runtime.o/.c)，已尝试编译器自身目录与当前目录
```

这不是 bug：发行包/开发布局都要求编译器与 `runtime/`、`lib/` 保持相对关系（`build/` 下的二进制通过 `../runtime` 命中）。

## 6. 回归测试跑法

- 一批 `Test/*.xt` 用 `引 "../lib/…"` / `引 "../xuantie_compiler/…"` 的相对路径，**必须在仓库 `Test/` 目录下运行**；复制到临时目录会编译失败（"文件不存在"），并非编译器缺陷。
- `timeout N cmd` 默认只发 SIGTERM，玄铁并发/纤程测试可能忽略 SIGTERM 导致 `timeout` 无限等待 ⇒ 用 `timeout -s KILL`（SIGKILL 不可忽略）。
- 负向测试（如 `30_错误模块路径`、`79_方法缺失诊断`）按设计就是"报错即通过"，别误判为失败。

## 7. 渲染桥是 Windows 深度绑定（遗留）

`lib/渲染/渲染桥.c`（1645 行）含：

- `typedef unsigned short wchar_t;` 与 macOS SDK 冲突（`__darwin_wchar_t`）
- `extern __declspec(dllimport) …` / `WINAPI(__stdcall)`（需 `-fdeclspec`/`-fms-extensions`，且 macOS 不支持 `__stdcall`）
- `MultiByteToWideChar` / `SetWindowTextW` / `GetWindowLongPtrW` / `SetWindowPos` / `PostMessageW` 等 Win32 API
- 渲染包含目录原来只剥离 `\libraylib.a`（反斜杠），POSIX 下 `-I` 指向 .a 文件本身 ⇒ `clang: error: no such file …`；已改为同时剥离 `/libraylib.a`。

macOS 渲染需对桥做 `#ifdef _WIN32` 守卫 + 用 raylib 跨平台 API 替换 Win32 窗口操作（`lib/渲染/libraylib.a` 的 macOS 版已就位，桥是最后一块）。
