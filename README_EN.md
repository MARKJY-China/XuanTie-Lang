# XuanTie (玄铁)

[![Version](https://img.shields.io/badge/version-0.15.4-red.svg)](https://gitee.com/mark-jy/xuantie)
[![Language](https://img.shields.io/badge/language-Go%20%7C%20LLVM-00ADD8.svg)](https://golang.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Guide](https://img.shields.io/badge/docs-syntax--guide-yellow.svg)](https://www.yuque.com/markjy/upsxwh/mr3r02mv71uloe7o)

**XuanTie, a modern general-purpose programming language that is Chinese to its core.**

XuanTie is independently designed and implemented by a 17-year-old developer from Guangdong, China. Starting from v0.2 on April 3, 2026, it has rapidly iterated to v0.15.4 in just half a month and is currently in the critical phase of developing its **Self-Hosted Compiler**.

XuanTie is more than just a localized syntax; its core philosophy is **"Logic Dimensionality Reduction under High-Entropy Semantics."** By using single Chinese characters with high information density as language primitives (e.g., `设` for var, `若` for if, `听` for listen, `求` for fetch), it allows the logical skeleton of the code to be seen at a glance. For native Chinese speakers, XuanTie offers logic construction with zero cognitive load.

<p align="center">
  <img src="assets/big-code-icon-redius.png" width="120" alt="XuanTie Logo"/>
  <br>
  <strong>Great weapons have no edge; great craftsmanship requires no effort. (重剑无锋，大巧不工)</strong>
</p>

---

## Key Features

- **Ultra-refined Syntax**: Keywords are almost entirely single characters. `设` (declare), `函` (function), `返` (return), `听` (server listen), `求` (network request), `道` (concurrency channel).
- **Modern Type System**: Supports optional type annotations, union types (`字|整`), null safety (`字?`), generics, and generic constraints.
- **Advanced OOP**: Supports single inheritance (`承`), method overriding (`覆`), three-level access control (`公/护/私`), and magic method overloading.
- **Result Paradigm**: Uses `成功()` (Success) / `失败()` (Failure) to wrap return values, supporting `.接着()` (Then) / `.否则()` (Else) chain calls, completely avoiding the `if err != nil` pyramid.
- **Native Concurrency**: Built on Go routines, providing natural high concurrency through `异步` (async), `等待` (await), and `并行` (parallel).
- **System-level Primitives**: `听`, `求`, `连`, and `执` are language-level keywords rather than external libraries, achieving "dimensionality reduction" for network and system operations.

---

## Quick Start

### 1. Hello World & String Interpolation
```xuantie
设 name = "XuanTie"
示("Hello, #{name}! 1+1=#{1+1}")
```

### 2. Functional Error Handling
```xuantie
函 getData(id) {
    若 id == 0 { 返 失败("Invalid ID") }
    返 成功({"name": "XuanTie", "value": 100})
}

getData(1).接着(函(obj) {
    示("Fetched: " & obj["name"])
}).否则(函(err) {
    示("Error: " & err)
})
```

---

## Technical Architecture: Self-hosting & LLVM

XuanTie's technical evolution has leapt from an **Interpreter** to a **Go Transpiler**, and now to **LLVM-based Self-hosting**.

### Self-hosting Architecture
XuanTie aims to achieve "XuanTie compiling XuanTie." The current architecture consists of two parts:
1. **Seed Compiler (Go)**: Responsible for compiling XuanTie source code into binaries; the starting point of self-hosting.
2. **Self-Hosted Compiler (XuanTie)**: Located in the `xuantie_compiler/` directory, entirely written in XuanTie, including Lexer, Parser, and LLVM IR generation backend.

### Hardcore Low-level Principles
- **Atomic ARC**: Memory management based on C11 `stdatomic.h`, with no GC pauses.
- **Tagged Pointers**: All variables are unified as `i64`. The lowest bits distinguish between pointer objects and inline integers, achieving zero memory allocation for integers.
- **O(1) Memory Pool**: A fixed-size free-list memory pool for small objects like AST nodes, greatly reducing `malloc/free` overhead.
- **LLVM Optimization**: Stack operations are transformed into register operations via `mem2reg`. Arithmetic operations are performed at the bit level to avoid boxing/unboxing.

---

## Why Choose XuanTie?

| Feature | XuanTie | Yi Language | Go / Python |
| :--- | :--- | :--- | :--- |
| **Openness** | Open source & Self-hosted | Closed system, Hardcoded C++ | Industry Standard |
| **Platform** | Native Cross-platform (LLVM) | Bound to Windows | Cross-platform |
| **Semantics** | High-entropy single-char primitives | Translated shell, non-Chinese core | English abbreviations |
| **Concurrency** | Language-level `Async/Await/Channel` | Depends on API libraries | Goroutines / Threads |
| **Error Handling** | Result Pipelining | Traditional Exceptions | `if err != nil` |

---

## Future Roadmap

1. **Step 1: Complete Self-hosting**  
   The compiler written in XuanTie can compile XuanTie code itself. This is the ultimate proof of the language's Turing completeness.
2. **Step 2: Rendering Engine**  
   Implement a native XuanTie rendering engine based on `raylib` or similar low-level wrappers, providing primitives like `画` (draw) and `界面` (UI).
3. **Step 3: XuanTie Foundry (IDE)**  
   Write XuanTie's own IDE using XuanTie. At that point, the entire XuanTie toolchain (compiler, rendering engine, IDE) will be written in XuanTie itself.

---

## Contribution & Community

XuanTie's ultimate goal is to become a truly commercial-grade, production-ready general-purpose Chinese programming language, giving native Chinese speakers their first productivity tool that is "Chinese in its very bones."

**Project Homepage**: [https://gitee.com/mark-jy/xuantie](https://gitee.com/mark-jy/xuantie)
