# 玄铁 (XuanTie) —— 中文编程语言自举编译器

## 编译与运行

```powershell
# 编译 Go 种子编译器（32位工具链，必须指定 GOARCH=386）
$env:GOARCH="386"; go build -o xt_go.exe .

# 用种子编译器编译自举编译器
.\xt_go.exe tie xuantie_compiler\玄铁.xt
Copy-Item 玄铁.exe xuantie_compiler\ -Force

# 用自举编译器编译并运行测试
.\玄铁.exe tie .\Test\02_字符串测试.xt
.\Test\02_字符串测试.exe
```

Go 模块根目录在项目根（`go.mod` 在此），编译器代码在 `compiler/` 子目录。

## 架构总览

```
xt_go.exe (Go种子) ──tie──▶ 玄铁.xt ──▶ 玄铁.exe (自举) ──tie──▶ 任意.xt
```

| 文件 | 行数 | 职责 |
|------|------|------|
| `compiler/llvm.go` | ~2800 | Go 种子编译器的 LLVM IR 后端，唯一需要修改的 Go 文件 |
| `xuantie_compiler/编译.xt` | ~3550 | 自举编译器的核心，四趟编译 |
| `runtime/xt_runtime.h` | ~350 | C 运行时头文件，定义所有 XTObject 结构体和 XTValue 标记系统 |
| `runtime/xt_runtime.c` | ~1450 | C 运行时实现 |

## XTValue 标记系统（核心概念）

```c
// xt_runtime.h
#define XT_TAG_INT   0x1ULL
#define XT_IS_INT(v) (((v) & 0x1) == 0x1)   // LSB=1 表示标记整数
#define XT_IS_PTR(v) (!XT_IS_INT(v))         // LSB=0 表示堆指针
#define XT_FROM_INT(i) (((XTValue)(i) << 1) | 0x1)  // 整数→标记值
#define XT_TO_INT(v)   ((int64_t)(v) >> 1)           // 标记值→整数
#define XT_NULL  0x0
#define XT_FALSE 0x2
#define XT_TRUE  0x4
```

- `raw_i64` = C int64，未标签化
- `i64` = XTValue，已标签化（指针或被 `XT_FROM_INT` 编码的整数）

## XTObject 结构体布局

```c
// 所有类型共享 3 字段头部
XTObject  { magic:i32, ref_count:i32, type_id:i32 }
XTString  { magic:i32, ref_count:i32, type_id:i32, data:i8*, length:i64, flags:i32 }
XTArray   { magic:i32, ref_count:i32, type_id:i32, elements:i8**, length:i64, capacity:i64 }
XTDict    { magic:i32, ref_count:i32, type_id:i32, buckets:i8***, count:i64, capacity:i64 }
XTResult  { magic:i32, ref_count:i32, type_id:i32, is_success:i32, _padding:i32, value:i64, error:i64 }
```

GEP 索引（从 0 开始）：`magic=0, ref_count=1, type_id=2, data/elements/buckets=3, length/count=4, flags/capacity/error=5/6`

## 当前 Bug（待修复）

**现象**：Go 种子编译器编译的 `玄铁.exe`，用它去编译 Test 02/03，输出的程序运行结果错误：

```
Test 02: 字节数: 空  字符数: 8  第一个字节: 72   (✅ 但 "字节数: 空" 不对，应为 10)
Test 03: 数组长度: 空  字典大小: 空  (❌ 全部为 "空")
         遍历字典: [崩溃，无输出]
```

**关键观察**：
- Go 种子直接编译 Test 02/03 → ✅ 全部正确。说明 C 运行时无 bug、Go 编译器 IR 生成无 bug。
- 自举编译器编译 Test 02/03 → ❌ 错误。说明问题在 **`编译.xt` 的代码生成逻辑**中。
- `字符数` 正常（调用 C 函数），但 `字节数`/`长度`/`大小` 异常（GEP 读字段）。
- `第一个字节: 72` 正常（GEP `i32 3` 读 data 字段），说明 GEP 基本机制没问题。

**根因推测**：`编译.xt` 中 `字节数`/`长度`/`大小` 的处理代码生成了错误的 IR。重点排查 `编译.xt` 中：
1. **[编译.xt L1716-L1744]**：`长度`/`大小`/`字节数` 处理，GEP 字段索引是否被正确编译
2. **[编译.xt L1742]**：`getelementptr %XTString, %XTString* ..., i32 0, i32 4` 的 `i32 4` 是否正确传递到最终汇编
3. **[编译.xt L3437-L3442]**：`写_存储_xt` + `確保I64` 对 raw_i64 的标签化是否正常

**调试方法**：自举编译器编译时会在当前目录生成 `DEBUG_temp_*.ll`（[编译.xt L3450](../xuantie_compiler/编译.xt#L3450)），保留该文件查看自举编译器为测试生成的 IR。

## 注意事项

- Go 种子用 `emit("  %s = ...")` 风格生成 IR；自举编译器用 `此.写出("  " & reg & " = ...")` 风格
- 所有代码注释和标识符使用中文
- 项目根 `AGENTS.md` 有详细规范，`versionLog.md` 记录版本历史，`GUIDE/` 下有实现笔记
