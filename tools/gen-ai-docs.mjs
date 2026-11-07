#!/usr/bin/env node
// tools/gen-ai-docs.mjs —— 生成 AI 文档层（all.txt / index.json / llms.txt）
//
// 目的（issue #118）：文档站 all.txt 曾与实现漂移近一个月，AI 按文档写代码、运行才报错。
// 本生成器在两处把"可信度"写死进产物：
//   1) 页头带「生成日期 + 对应编译器版本」——一眼看出文档对应哪个分发包；
//   2) 每个文件/每条 API 附「实现状态」——例外集中在 tools/ai-doc-status.json，默认「已实现」。
//
// 用法：
//   node tools/gen-ai-docs.mjs            # 输出到 dist/ai-docs/
//   node tools/gen-ai-docs.mjs --out DIR  # 指定输出目录
//
// 内容来源：GUIDE/（排除内部实现笔记）；状态来源：tools/ai-doc-status.json；
// 版本来源：xuantie_compiler/玄铁.xt 的 版本号 常量（单一真源，不手写）。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, 'dist', 'ai-docs')

// 内部实现/计划类文档不进 AI 层（与站点侧口径一致）
const EXCLUDE = new Set(['性能优化待处理表.md', '种子编译器实现笔记.md', '自举编译器实现笔记.md', '铁铺设计笔记.md'])

const STATUS = JSON.parse(readFileSync(join(ROOT, 'tools', 'ai-doc-status.json'), 'utf8'))
const DEF = STATUS['默认状态'] || '已实现'

function readVersion() {
  const p = join(ROOT, 'xuantie_compiler', '玄铁.xt')
  const m = readFileSync(p, 'utf8').match(/设\s+版本号\s*=\s*"([^"]+)"/)
  return m ? m[1] : '（未知）'
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else if (name.endsWith('.md') && !EXCLUDE.has(name)) acc.push(full)
  }
  return acc
}

function statusOfFile(rel) {
  const e = (STATUS['文件例外'] || {})[rel]
  return e ? { 状态: e['状态'] || DEF, 说明: e['说明'] || '' } : { 状态: DEF, 说明: '' }
}

// 给 API 参考页里每条 `### \`R.xxx(...)\`` 加状态标注（issue #118 的"每个 API 附状态"）
function annotateApiHeadings(md) {
  const fnEx = STATUS['函数例外'] || {}
  return md.replace(/^### `([^`]+)`$/gm, (line, sig) => {
    const name = sig.split('(')[0].trim()
    const e = fnEx[name] || fnEx[sig]
    const st = e ? e['状态'] : DEF
    const note = e && e['说明'] ? `｜${e['说明']}` : ''
    return `${line}\n\n> 状态：${st}${note}`
  })
}

const version = readVersion()
const today = new Date().toISOString().slice(0, 10)
const files = walk(join(ROOT, 'GUIDE')).sort((a, b) => a.localeCompare(b, 'zh'))
const rels = files.map((f) => relative(ROOT, f).replace(/\\/g, '/'))

mkdirSync(OUT, { recursive: true })

const header = [
  '# 玄铁文档 · AI 纯文本层（all.txt）',
  '',
  `> 生成日期：${today}`,
  `> 对应编译器版本：${version}`,
  `> 状态口径：默认「${DEF}」；例外登记在 tools/ai-doc-status.json（每个文件与每个 API 标题下都标注）`,
  `> 机器可读索引：index.json（同目录，含每文件的路径/状态/字节数/生成日期/版本）`,
  '> 使用建议：若本文档日期/版本与手上的分发包不一致，先按「状态」标注核对，再决定是否照抄示例。',
  '',
].join('\n')

const parts = [header]
const index = { generated: today, version, defaultStatus: DEF, files: [] }

for (let i = 0; i < files.length; i++) {
  const full = files[i]
  const rel = rels[i]
  let md = readFileSync(full, 'utf8')
  const st = statusOfFile(rel)
  if (rel.includes('/API/') || rel.includes('\\API\\')) md = annotateApiHeadings(md)
  parts.push('='.repeat(78))
  parts.push(`文件：${rel}`)
  parts.push(`状态：${st.状态}${st.说明 ? '｜' + st.说明 : ''}`)
  parts.push('-'.repeat(78))
  parts.push(md.trimEnd())
  parts.push('')
  index.files.push({
    path: rel,
    status: st.状态,
    note: st.说明 || '',
    bytes: Buffer.byteLength(md, 'utf8'),
  })
}

writeFileSync(join(OUT, 'all.txt'), parts.join('\n'), 'utf8')
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2), 'utf8')

const llms = [
  '# 玄铁 XuanTie',
  '',
  `> 生成日期：${today}｜对应编译器版本：${version}`,
  '',
  '- 纯文本文档（推荐给 AI 抓取）：./all.txt',
  '- 机器可读索引（含每篇状态）：./index.json',
  '- 注意：示例若与 index.json 里的「状态」冲突，以状态标注为准。',
  '',
]
writeFileSync(join(OUT, 'llms.txt'), llms.join('\n'), 'utf8')

const exceptions = rels.filter((r) => statusOfFile(r).状态 !== DEF)
console.log(`AI 文档层：${files.length} 篇 → ${OUT}（日期 ${today}，版本 ${version}）`)
console.log(`  状态例外：${exceptions.length} 篇${exceptions.length ? '（' + exceptions.join('、') + '）' : ''}`)
console.log(`  all.txt ${(Buffer.byteLength(parts.join('\n')) / 1024).toFixed(1)} KB / index.json 已生成`)
