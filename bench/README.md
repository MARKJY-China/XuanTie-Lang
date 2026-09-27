# 玄铁性能基准 (bench)

本目录是玄铁性能数据的**唯一权威存放处**：语料、跑分器、历史快照、优化史。

目标一句话：**每个版本都能回答"相比上一版本，性能提升了百分之几、启动快了几毫秒"**，且任何人都能在自己机器上一键复现。

## 目录结构

```
bench/
├── run.py                跑分器(仅标准库; 计时/解析/存快照/对比)
├── README.md             本文(口径与纪律)
├── 优化历史.md            至今所有性能优化工作与结果(含待查回归)
├── cases/                基准语料(玄铁 + node/java/go/python 同构对照)
│   ├── xt_bench.xt       原 temp/1.xt 逐字抢救 + 追加 fib30 用例
│   ├── node_bench.js     原 temp/bench_node.js
│   ├── BenchJava.java    原 temp/BenchJava.java(类名须与文件名一致,故不改名)
│   ├── go_bench.go       原 temp/bench_go.go
│   └── python_bench.py   原 temp/bench_py.py
└── results/
    ├── 2026-08-15.json   历史回填快照(kind=historical, 单次测量)
    └── <日期>.json       每次跑分产出的实测快照(kind=measured, 中位数)
```

## 用法

```bash
python bench/run.py                  # 跑玄铁基准 → results/<日期>.json
python bench/run.py --runs 7         # 运行 7 次取中位数
python bench/run.py --with-peers     # 同时跑 node/java/go/python 对照
python bench/run.py --xtc build/xtc_s4.exe
python bench/run.py --compare        # 与 results/ 里上一份快照对比(打印每项 Δ% 与 Δms)
python bench/run.py --compare a.json b.json
```

跑分器记录的内容：机器信息（平台/CPU/核数）、工具链身份（xtc 版本行与 md5、**自举链各级大小与 md5**、clang/gcc/go/node/java/python 版本、Go 宿主架构）、编译耗时（冷/热，冷=空缓存目录）、启动耗时（空程序，N 次最小值）、各用例的**中位数 + 最小值 + 全部原始值**。

## 测量纪律

承接 `GUIDE/性能优化待处理表.md` 的四条，并补足此后暴露出的缺口：

1. **优化前后必须复测全表**，数据就地更新并标注日期。
2. **单项优化必须附最小 benchmark**，防性能回退。
3. **禁止只贴"提升 N 倍"而无绝对微秒数**——绝对值才能跨语言对比。
4. **记录机器与工具链身份**：没有这些上下文的数字不算数据（旧表缺的正是这一层，导致回填数据无法逐题复现）。
5. **取中位数，且保留全部原始值**：`--runs` 默认 5。抖动大的用例（如空函数调用）必须看 `all_us` 才能判断差异是否显著。
6. **口径不同的快照不混比**：单次测量 vs 中位数、不同机器、不同优化等级都不行；`--compare` 会显式警告。
7. **Go 对照注意本机是 windows/386**（32 位，数据偏弱），换 amd64 后需整表重测——这是待办，不是已完成。
8. **红线**：任何对外发布的性能数字，必须能由本目录的语料 + `run.py` + 快照 JSON 复现；做不到就不发。

## 加数据流程

1. 改/加语料 → `bench/cases/`（对照语言尽量保持同构，改语义等价性要写清）。
2. `python bench/run.py --with-peers` → 生成新快照。
3. `python bench/run.py --compare` → 看每项变化，**把异常（无论好坏）写进 `优化历史.md`**，不要只记战果。
4. 若目标是性能优化：优化项、根因、前后数据、验证方式一起写进 `优化历史.md`。

## 与 GUIDE/性能优化待处理表.md 的关系

那份表是 **2026-08-15 的历史快照 + 待办清单（P2 字典、P3 浮点装箱、P4 控制流与调用仍未做）**，保留原文以避免丢失当年的分析与数字；**新数据一律进 `bench/`**。两者题目名称若有出入（如旧表"列表追加"、语料输出"列表添加"），以语料为准，旧表用词在快照 JSON 的 `name_in_source` 字段里保留。
