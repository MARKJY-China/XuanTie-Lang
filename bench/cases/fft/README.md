# 4096 点 FFT 七语言同构基准

同一算法：原地基 2 FFT、f64、单线程、预计算旋转因子；每语言先跑 1 次预热，
再计时 100 次，单次 = 总耗时 / 100，取 5 次中位。初始化不计时。

| 文件 | 语言 | 构建/运行 |
|---|---|---|
| `xt_fft.xt` | 玄铁 | `build/xtc_s4.exe 铁 bench/cases/fft/xt_fft.xt -O3 -sc temp/fft_xt.exe` |
| `rust_fft.rs` | Rust | `rustc -O ... -o temp/fft_rust.exe` |
| `go_fft.go` | Go | `go build -o temp/fft_go.exe ...` |
| `node_fft.js` | Node | `node ...` |
| `python_fft.py` | Python | `python ...` |
| `BenchFft.java` | Java | `javac -d temp/java_fft ...`，`java -cp temp/java_fft BenchFft` |
| `vix_fft.vix` | Vix 0.5.0 | `vixc ... -obj ... -opt=l3` + `gcc obj -o exe -lm` |

当前快照：`bench/results/2026-11-21.json`（Windows i5-12400F）。
玄铁 5,000 µs / Rust 51 / Vix 50 / Go 68 / Node 130.8 / Java 145.4 / Python 7,445.3 µs。

注意：
- 各语言编译器优化等级不同（Rust `-O`、Vix `-opt=l3`、玄铁 `-O3`），这是“各语言惯用构建”口径。
- Vix 数组按值传递，FFT 主体内联在计时循环里，避免每轮 move。
- 计时粒度：Vix 的 `clock()` 为毫秒级；单次值按 100 次平均，仍有 ±10 µs 量化误差。
