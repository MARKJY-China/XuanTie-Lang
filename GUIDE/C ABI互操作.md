# C ABI 互操作（实验）

> 对标编译器 v1.0-rc.6-dev.5。本页描述 `-lib` 实验性 C ABI 导出（issue #164），ABI 在 1.0 前不承诺稳定。

## 能做什么

`xtc 铁 库.xt -lib -sc libxtmath.o --emit-header` 会：

- 生成普通 `.o`（库对象）；
- 为带 `为 "ascii_name"` 的函数生成 **C ABI wrapper**（ASCII 符号）；
- 生成同名 `.h`：C/Rust/Zig 可直接 `#include`；
- 生成 `xt_lib_init()`：C 侧首次调用前执行一次（内部调 `xt_init`）。

```xt
// math.xt
公 函 加(甲: 整, 乙: 整): 整 为 "xt_add" {
    返 甲 + 乙
}

公 函 取正(值: 整): 布尔 为 "xt_is_positive" {
    返 值 > 0
}

公 函 问候(名: 字): 字 为 "xt_greet" {
    返 "你好，" & 名
}
```

```bash
xtc 铁 math.xt -lib -sc libxtmath.o --emit-header
# 产出 libxtmath.o + libxtmath.h
```

```c
#include "libxtmath.h"
#include <stdio.h>
#include <string.h>

int main(void) {
    xt_lib_init();
    int64_t n = xt_add(2, 3);              /* 5 */
    int32_t ok = xt_is_positive(7);        /* 1 */
    char* s = xt_greet("玄铁");            /* 返回值归调用方所有 */
    printf("%lld %d %s\n", (long long)n, ok, s);
    xt_cabi_string_free(s);                /* 必须释放字符串返回值 */
    return 0;
}
```

```bash
gcc -std=c11 demo.c libxtmath.o runtime/xt_runtime.o ... \
    -lws2_32 -lsecur32 -o demo        # Windows MinGW/clang
gcc -std=c11 demo.c libxtmath.o runtime/*.o \
    -lpthread -lm -ldl -o demo        # Linux
```

调用方仍必须链接运行时对象（与 `-lib` 多对象链接相同），Windows 目标 ABI 是 **MinGW/clang**，不能直接用 MSVC 链接 `.o`。

## 类型映射（v0）

| 玄铁 | C ABI | 说明 |
|---|---|---|
| `整` / `整数` | `int64_t` | wrapper 内部转 tagged i64 |
| `布尔` | `int32_t` | `0/1`，不暴露内部 `4/2` 哨兵 |
| `字` / `字符串` 参数 | `const char*` | UTF-8；由 wrapper 创建临时 XTString |
| `字` / `字符串` 返回 | `char*` | **所有权移交调用方**，用 `xt_cabi_string_free` 释放 |
| `空` 返回 | `void` | — |

不支持对象/数组/字典/结果/小数/泛型等；遇到会明确编译错误，不静默生成错误 ABI。

## 约束与已知限制

- 导出名必须是合法 ASCII C 标识符；重复导出名报错。
- 导出函数的内部符号使用 `__xt_cabi_<导出名>`，因此 `nm` 不会出现中文全局符号；非导出函数仍可能保留中文符号。
- C 字符串参数在每次调用时新建 XTString；返回值字符串由 wrapper 复制并释放内部对象，调用方必须调用 `xt_cabi_string_free`。
- 这是 **实验 ABI**：1.0 前布局/所有权约定可能调整；正式跨语言生产接入请锁定版本。
- 未实现自动绑定（C++/Python/Rust bindgen）；Rust 可直接 `extern "C"` 按头文件声明调用。
- 不做异常/对象模型跨语言。

## CI

`tools/check_c_abi.py` 在 Windows 与 Linux 上执行：

1. `xtc -lib --emit-header` 生成 `.o`/`.h`；
2. 检查 `.h` 声明与 `nm` ASCII 导出符号、无 `main`、无中文全局符号；
3. 用 gcc/clang 链接 C demo 并运行整数/布尔/字符串断言。

<sub><span style="color:#999">最后更新：2026-11-21</span></sub>
