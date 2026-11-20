// scripts/sync-benchmark.mjs — 把 bench/charts 接进文档站 /benchmark
//
// 站点页面不直接复用 bench/charts/index.html（那是无导航的本地画廊），
// 而是生成同源的 VitePress Markdown：图片复制到 site/public/benchmark，
// 卡片、图注、口径说明在这里统一生成，避免两处手改漂移。
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(SITE, '..')
const SRC = join(ROOT, 'bench', 'charts')
const OUT = join(SITE, 'public', 'benchmark')
const PAGE = join(SITE, 'benchmark.md')

const STANDARD = [
  ['01_空函数调用1e6.png', '空函数调用 · 1,000,000 次'],
  ['02_字符串拼接1e5.png', '字符串拼接 · 100,000 次'],
  ['03_列表添加1e5.png', '列表添加 · 100,000 次'],
  ['04_字典插入1e4.png', '字典插入 · 10,000 次'],
  ['05_浮点累加1e6.png', '浮点累加 · 1,000,000 次'],
  ['06_乘模1e6.png', '乘模 · 1,000,000 次'],
  ['07_分支1e7.png', '分支 · 10,000,000 次'],
  ['08_嵌套循环1e6.png', '嵌套循环 · 1,000,000 次'],
  ['09_fib30递归.png', 'fib30 递归'],
]
const SPECIAL = [
  ['10_FFT4096点.png', 'FFT 4096 点 · 五语言外部实测'],
  ['11_小数数组4096x500.png', '小数数组微基准 · 4096×500'],
  ['12_FFT小数数组.png', 'FFT 4096 点 · 小数数组优化'],
]

if (!existsSync(SRC)) {
  console.error(`未找到 ${SRC}，先跑 python bench/chart.py`)
  process.exit(1)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const available = new Set(readdirSync(SRC).filter((f) => f.endsWith('.png')))
const missing = [...STANDARD, ...SPECIAL].map(([f]) => f).filter((f) => !available.has(f))
if (missing.length) {
  console.error(`缺少图表: ${missing.join(', ')}；先跑 python bench/chart.py`)
  process.exit(1)
}
for (const f of available) copyFileSync(join(SRC, f), join(OUT, f))

const card = ([file, title]) => `  <a class="bench-card" href="/benchmark/${file}" target="_blank" rel="noopener">
    <img src="/benchmark/${file}" alt="${title}" loading="lazy">
    <span>${title}</span>
  </a>`

const md = `---
title: 性能对比
description: 玄铁与 Node/Java/Go/Python/Rust/Vix 的基准对比图
---

# 玄铁性能对比

> 数据由 \`bench/run.py\` 产出、\`bench/chart.py\` 渲染；对数刻度，柱子越短越快。
> 每个用例一张图，玄铁高亮；下方明细含总耗时、单次、相对基准与样本数。

数据快照：**2026-11-20（v1.0-rc.5）** · 机器：12th Gen Intel i5-12400F · 取 5 次中位数。
标准 9 项由 \`bench/run.py --with-peers\` 跑出；Go 为 windows/386，Vix 空函数/嵌套循环
被优化器折叠时标 \`0（编译期消除）\`。

## 标准基准

<div class="bench-grid">
${STANDARD.map(card).join('\n')}
</div>

## issue #168 专图

<div class="bench-grid">
${SPECIAL.map(card).join('\n')}
</div>

- **FFT 4096 点**：issue #168 的外部实测（macOS arm64、xtc rc.5），不是本仓库
  \`bench/run.py\` 复现数据，仅作定位对照。
- **小数数组微基准**：Windows i5-12400F、4096×500、5 次中位数；普通数组直取
  ~894.73 ms → 小数数组 ~79.19 ms，标量对照 ~22.68 ms。

## 口径与来源

- 完整数据：仓库 \`bench/results/\`；生成脚本：\`bench/run.py\`、\`bench/chart.py\`。
- 标准用例的绝对耗时随机器/负载波动；只看同一张图内的相对关系。
- 具体覆盖、已知缺口与复现命令见仓库 [bench/README.md](https://github.com/MARKJY-China/XuanTie-Lang/blob/develop/bench/README.md)。

<style>
.bench-grid {
  display: grid;
  gap: 18px;
  margin: 18px 0 28px;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
}
.bench-card {
  display: block;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  transition: border-color .15s, box-shadow .15s;
}
.bench-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 6px 20px rgba(16, 24, 40, .10);
}
.bench-card img { display: block; width: 100%; height: auto; background: #fff; }
.bench-card span {
  display: block;
  padding: 10px 13px;
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 600;
}
@media (max-width: 640px) {
  .bench-grid { grid-template-columns: 1fr; }
}
</style>
`
writeFileSync(PAGE, md, 'utf8')
console.log(`性能页: site/benchmark.md（${STANDARD.length + SPECIAL.length} 张图）`)
