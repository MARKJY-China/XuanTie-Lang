# 玄铁 (XuanTie)

> **仓库定位**｜主仓库在 **GitHub**：<https://github.com/MARKJY-China/XuanTie-Lang> —— Issue / PR / 最新提交均以主仓库为准。
> **如果你正通过 Gitee 打开本页**：这里是**副仓库（镜像）**，由主仓库同步而来，可能略滞后；除国内访问受限的场景外，请优先使用主仓库。
>
> **给 AI / 爬虫**：请优先读取 <https://xt.markjy.com/ai/index.html> —— 零 CSS / 零 JS 的纯文本文档索引（全部文档，markdown 原文包在 `<pre>` 中），比解析文档站的 HTML 更省 token、结构也更完整；只需单次抓取时可用 <https://xt.markjy.com/ai/all.txt>（全文单文件）。
> **给人**：官网文档站 <https://xt.markjy.com>。

[![版本](https://img.shields.io/badge/版本-1.0--rc.2-red.svg)](https://gitee.com/mark-jy/xuantie)
[![语言](https://img.shields.io/badge/语言-Go%20%7C%20LLVM-00ADD8.svg)](https://golang.org)
[![许可证](https://img.shields.io/badge/许可证-MIT-green.svg)](LICENSE)
[![语法指南](https://img.shields.io/badge/文档-语法指南-yellow.svg)](./GUIDE/玄铁语言参考手册.md)
[![历史更新](https://img.shields.io/badge/文档-历史更新-y.svg)](versionLog.md)
[![EN-README](https://img.shields.io/badge/README-English-blue.svg)](README_EN.md)

## 玄铁是什么
玄，天外之色；铁，至重之材。玄铁之名，来自金庸笔下那柄「重剑无锋，大巧不工」的重剑——玄铁之重，铸成你手中之轻。
「重」在底层：自举编译器、原生机器码、确定性构建，每一处都不取巧。「轻」在手上：单字关键字、母语可读、装上就写、编译即原生。
玄铁不是语法换皮。编译器本体 `xuantie_compiler/` 由 10,890 行玄铁代码写成（全仓 `.xt` 源码 158 个文件、26,616 行），能编译它自己——GitHub 的语言占比条不认识 `.xt`，所以你在占比条里看不见这个项目最硬核的部分。
玄铁由一名 17 岁的中国开发者设计并维护，约 90% 的代码由旗舰大模型在作者的工程约束下生成——每一次更新都经过全量回归。你可以把玄铁看作一门语言，也可以看作一份公开的证据：一个人 + AI，能把"造语言"这件事推到哪。


<p align="center">
  <img src="assets/xuantie_logo_dark_256px.png" width="120" alt="玄铁徽标"/>
  <br>
  <strong>重剑无锋，大巧不工</strong>
</p>

---

## 一眼玄铁
```xuantie
设 名字 = "玄铁"
示("你好，#{名字}！1+1=#{1+1}")
```
```xuantie
函 获取数据(id) {
    若 id == 0 { 返 失败("无效 ID") }
    返 成功({"名": "玄铁", "值": 100})
}

获取数据(1).接着(函(对象) {
    示("获取到: " & 对象["名"])
}).否则(函(错) {
    示("错误: " & 错)
})
```
```xuantie
// 异步 + 通道：网络请求是语言级挂起点
设 任务 = 异步 {
    设 resp = 求("https://example.org")
    若 resp.成功 { 示("请求成功") }
}
等待(任务)
```

---

## 技术架构：自举与 LLVM

玄铁的技术演进经历了从**解释器**、**Go 转译器**到**LLVM 自举**再到如今**玄铁编译器用玄铁自己写**的快速飞跃。

### 自举架构 (Bootstrapping)

玄铁的目标是实现“玄铁编玄铁”。目前架构由两部分组成：

1. **种子编译器 (Go)**：负责将玄铁源码编译为二进制，是自举的起点。
2. **自举编译器 (XuanTie)**：位于 `xuantie_compiler/` 目录，完全由玄铁编写，包含词法分析、语法分析与 LLVM IR 生成后端。

### 底层硬核原理

- **原子引用计数 (Atomic ARC)**：基于 C11 `stdatomic.h` 的内存管理，无 GC 停顿。
- **标记指针 (Tagged Pointers)**：所有变量统一为 `i64`，最低位区分指针与内联整数，内联整数实现零内存分配。
- **O(1) 内存池**：针对 AST 节点等小对象引入定长空闲链表内存池，极大降低 `malloc/free` 开销。
- **LLVM 深度优化**：通过 `mem2reg` 优化将栈操作转化为寄存器操作，算术运算在位级别完成，避免装箱拆箱。

---

## 为什么选择玄铁？


| 特性         | 玄铁 (XuanTie)           | 易语言               | Go / Python     |
| :------------- | :------------------------- | :--------------------- | :---------------- |
| **开放性**   | 开源且自举，任何人可贡献 | 封闭系统，硬编码 C++ | 工业标准        |
| **平台**     | 天生跨平台 (LLVM)        | 绑定 Windows         | 跨平台          |
| **语义**     | 高熵单字原语，逻辑直观   | 汉化外壳，底层非中文 | 英文缩写        |
| **并发**     | 语言级`异步/等待/道`     | 依赖 API 库          | 协程 / 线程     |
| **错误处理** | Result 管道化            | 传统异常             | `if err != nil` |

---

## 安装上手
Windows：从 Releases 下载 `xuantie_v1.0-rc.2_setup.exe`（自带 clang/MinGW，装完即可在终端使用 `xtc` 与 `tiepm`），或使用绿色压缩包解压即用。
```bash
xtc tie hello.xt        # 编译
./hello.exe            # 运行
```
macOS / Linux：运行时已完成三平台化（含 ARM64），构建方式见文档站。

---

## 其他

可能有人会觉得几个问题或疑问：

1. 部分代码编写像LLM写的或者说绝大部分都极其像LLM写的
   * 这个直觉/感觉是对的，有90%代码确实由Claude-Fable5(High)+KimiK3(Max)+DeepSeekV4Pro(Max)完成。（为什么是三个模型加一起呢？因为不同时期我用不同的模型，其中Fable5是官方API用的，不是中转站。直至2026-09-27，ClaudeFable5开发代码占3%，KimiK3开发代码占27%，DeepSeekV4Pro开发代码占49%，DeepSeekV4.1Flash开发代码占9%，GLM5.3开发代码占12%）不过请放心，玄铁拥有覆盖面广的测试集，每一次不管是大小更新都会严格经过全量回归测试，回归测试不仅包含功能正确性验证，还包含偶发性Bug等模糊测试，稳定安全。但当然作者还是建议1.0版本前依然只作为小项目使用，且不长期依赖。
2. 作者更新时很快时很慢
   * 这个随缘更新，虽然说作者的初衷和本意以及目标的确是打造一个“工程上不必妥协的中文通用编程语言生产力工具”，并且本项目完全MIT开源，大家都是可以拿去玩和加入成为贡献者的。作者只要有空和有时间就来打磨更新，可能偶尔因个人原因停滞但绝不会停止维护。

## 贡献与致谢

玄铁的目标：让中文母语开发者拥有一门骨子里是中文、且工程上不必妥协的生产力工具。

**特别感谢**：[k4m7v2pz](https://github.com/k4m7v2pz) —— 首位外部贡献者（macOS 适配与多个 issue/PR）。

---
**项目主页**: [https://xt.markjy.com](https://xt.markjy.com)  |   **官方论坛**: [https://bbs.xt.markjy.com](https://xt.markjy.com) | **许可证**：MIT

