// scripts/build-ai-docs.mjs —— 生成站点的 AI 文档层（/ai/）
//
// 产物（与历史线上结构一致）：
//   ai/index.html        分组索引（标题 + 链接 + 篇数 + 生成日期/版本）
//   ai/guide/*.html      每篇 GUIDE 的纯文本镜像（markdown 原文包在 <pre> 里，零 CSS/JS）
//   ai/versionLog.html   版本日志纯文本镜像
//   ai/all.txt           全部文档拼接（页头带生成日期 + 编译器版本 + 状态标注）
//   ai/index.json        机器可读索引（每篇状态/字节数，供 AI 判断可信度）
//   ai/llms.txt          AI 抓取入口
//
// 内容与状态由仓库 tools/gen-ai-docs.mjs 统一产出（单一真源），本脚本只负责排版成站点页面。

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(SITE, '..')
const GEN = join(SITE, '.vitepress', 'ai-gen')
const OUT = join(SITE, 'public', 'ai')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function titleOf(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

function groupOf(p) {
  if (p.startsWith('GUIDE/API/')) return 'API 参考'
  if (p.startsWith('GUIDE/例程/')) return '完整例程讲解'
  if (p.startsWith('GUIDE/手册/')) return '手册章节'
  if (p.startsWith('GUIDE/关键字/')) return '关键字速查'
  if (p.startsWith('GUIDE/UI/选项键/')) return 'UI 选项键'
  if (p.startsWith('GUIDE/UI/')) return 'UI 状态系统与渲染'
  if (p.includes('实现笔记') || p.includes('铁铺设计笔记')) return '内部实现'
  if (p === 'versionLog.md') return '版本日志'
  return '语言指南与参考手册'
}

const ORDER = ['语言指南与参考手册', 'API 参考', '完整例程讲解', '手册章节', '关键字速查', 'UI 状态系统与渲染', 'UI 选项键', '内部实现']

// ① 先用仓库生成器产出 all.txt / index.json / llms.txt（含日期、版本、状态标注）
rmSync(GEN, { recursive: true, force: true })
mkdirSync(GEN, { recursive: true })
execFileSync(process.execPath, [join(ROOT, 'tools', 'gen-ai-docs.mjs'), '--out', GEN], { stdio: 'inherit' })
const index = JSON.parse(readFileSync(join(GEN, 'index.json'), 'utf8'))

// ② 逐篇生成纯文本镜像
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'guide'), { recursive: true })

const pageName = (p) => 'guide/' + relative('GUIDE', p).replace(/\\/g, '/').replace(/\.md$/, '.html')
const groups = new Map()

for (const f of index.files) {
  const src = join(ROOT, f.path)
  if (!existsSync(src)) continue
  const md = readFileSync(src, 'utf8')
  const name = f.path.replace(/^GUIDE\//, '').replace(/\.md$/, '')
  const title = titleOf(md, name)
  const rel = pageName(f.path)
  const dest = join(OUT, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n<title>${esc(title)} — 玄铁 XuanTie 文档</title>\n</head><body><pre>${esc(md)}</pre></body></html>\n`, 'utf8')
  const g = groupOf(f.path)
  if (!groups.has(g)) groups.set(g, [])
  groups.get(g).push({ title, rel, status: f.status, note: f.note })
}

// ③ 版本日志镜像（内容取仓库根 versionLog.md）
const vl = join(ROOT, 'versionLog.md')
if (existsSync(vl)) {
  const md = readFileSync(vl, 'utf8')
  writeFileSync(join(OUT, 'versionLog.html'), `<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n<title>${esc(titleOf(md, '版本日志'))} — 玄铁 XuanTie 文档</title>\n</head><body><pre>${esc(md)}</pre></body></html>\n`, 'utf8')
}

// ④ 索引页
const html = []
html.push('<!DOCTYPE html>')
html.push('<html lang="zh-CN"><head><meta charset="utf-8">')
html.push('<title>玄铁 XuanTie —— 供 AI 阅读的文档索引</title>')
html.push('<meta name="description" content="玄铁编程语言文档的纯文本镜像,供 AI 读取">')
html.push('</head><body>')
html.push('<h1>玄铁 XuanTie —— 供 AI 阅读的文档索引</h1>')
html.push('<p>本目录是玄铁官方文档的纯文本镜像(零 CSS / 零 JS / 零高亮标记),每篇为 markdown 原文包在 &lt;pre&gt; 中,内容与文档站一一对应。</p>')
html.push(`<p>人类阅读请访问 <a href="https://xuantie.markjy.com/">https://xuantie.markjy.com/</a>;文档篇数:${index.files.length}。</p>`)
html.push(`<p>生成日期:<strong>${esc(index.generated)}</strong> ｜ 对应编译器版本:<strong>${esc(index.version)}</strong> ｜ 状态口径:默认「${esc(index.defaultStatus)}」,例外在各篇链接后标注。</p>`)
html.push('<p>机器可读:<a href="all.txt">all.txt</a> ｜ <a href="index.json">index.json</a> ｜ <a href="llms.txt">llms.txt</a> ｜ <a href="versionLog.html">版本日志</a></p>')
for (const g of [...groups.keys()].sort((a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
})) {
  html.push(`<h2>${esc(g)}</h2>`)
  html.push('<ul>')
  for (const item of groups.get(g)) {
    const badge = item.status && item.status !== index.defaultStatus ? ` <em>[${esc(item.status)}${item.note ? '：' + esc(item.note) : ''}]</em>` : ''
    html.push(`<li><a href="${item.rel}">${esc(item.title)}</a>${badge}</li>`)
  }
  html.push('</ul>')
}
html.push('</body></html>')
writeFileSync(join(OUT, 'index.html'), html.join('\n'), 'utf8')

// ⑤ 三个机器可读产物直接沿用生成器的（all.txt 页头已带日期/版本/状态）
for (const f of ['all.txt', 'index.json', 'llms.txt']) copyFileSync(join(GEN, f), join(OUT, f))

// ⑥ 站点根 /llms.txt：llms.txt 规范要求放在站点根，爬虫只探根路径，/ai/llms.txt 探不到
//    （实测：https://<域名>/llms.txt 404，/ai/llms.txt 200）。这里生成一份短指针，
//    与 /ai/ 层同源（日期/版本都从 index.json 取），避免手写后过期。
const rootLlms = [
  '# 玄铁（XuanTie）',
  '',
  `> 生成日期：${index.generated}｜对应编译器版本：${index.version}`,
  `> 中文编程语言，MIT 开源。默认状态口径「${index.defaultStatus}」，例外登记在各篇标题下。`,
  '',
  '## 文档',
  '',
  '- 全部文档（纯文本，推荐给 AI 抓取）：/ai/all.txt',
  '- 机器可读索引（每篇路径/状态/字节数）：/ai/index.json',
  '- 分层入口（按目录分组）：/ai/',
  '',
].join('\n')
writeFileSync(join(SITE, 'public', 'llms.txt'), '\uFEFF' + rootLlms, 'utf8')

console.log(`build-ai-docs: ${index.files.length} 篇 → ${OUT}（${index.generated} / ${index.version}）`)
