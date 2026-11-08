#!/usr/bin/env node
// tools/stamp-guide.mjs —— 给 GUIDE 每篇文档底部维护「最后更新」注解
//
// 规则（也写进 AGENTS.md，属永久记忆项）：GUIDE/ 下的每篇 .md 末尾都有一行
//   <sub><span style="color:#999">最后更新：YYYY-MM-DD</span></sub>
// 谁改了文档，就把这行日期改成当天；改完跑一次本脚本可批量校正。
//
// 日期口径：
//   * 文件有**实质内容改动**（相对 HEAD 的 diff 里除注解行以外的变化）→ 今天；
//   * 否则沿用已有注解；没有注解时取最后一次 git 提交日期（无 git 记录则取 mtime）。
//   只看实质改动，是为了避免"注解行本身被提交"导致日期无限自增。
//
// 用法：
//   node tools/stamp-guide.mjs            # 批量写入/校正
//   node tools/stamp-guide.mjs --check    # 只检查：缺注解、或有实质改动但日期不是今天 → 退出码 1
//
// GUIDE/API/ 是 tools/gen-api.mjs 的生成物，不盖戳。

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUIDE = join(ROOT, 'GUIDE')
const SKIP_DIRS = new Set(['API'])
const STAMP_RE = /^<sub><span style="color:#999">最后更新：([0-9]{4}-[0-9]{2}-[0-9]{2})<\/span><\/sub>\s*$/
const checkOnly = process.argv.includes('--check')

const today = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collect(join(dir, e.name), out)
    } else if (e.name.endsWith('.md')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

// 相对 HEAD 是否有"实质"改动（忽略注解行与文件头 +/- 标记）
function hasRealChange(rel) {
  const st = git(['status', '--porcelain', '--', rel])
  if (!st) return false
  if (st.startsWith('??')) return true
  const diff = git(['diff', '-U0', '--', rel])
  if (!diff) return false
  return diff
    .split(/\r?\n/)
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .some((l) => { const t = l.slice(1).trim(); return t !== '' && !STAMP_RE.test(t) })
}

function gitDate(rel) {
  return git(['log', '-1', '--format=%cs', '--', rel])
}

function mtimeDate(file) {
  const d = new Date(statSync(file).mtimeMs)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const files = collect(GUIDE).sort((a, b) => a.localeCompare(b, 'zh'))
const missing = []
const outdated = []
let changed = 0

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const real = hasRealChange(rel)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const last = lines.length ? lines[lines.length - 1] : ''
  const m = last.match(STAMP_RE)

  let want
  if (m) {
    want = real ? today : m[1]
    if (want === m[1]) continue
    if (checkOnly) { outdated.push(`${rel}（${m[1]} → ${today}）`); continue }
    lines[lines.length - 1] = `<sub><span style="color:#999">最后更新：${want}</span></sub>`
  } else {
    if (checkOnly) { missing.push(rel); continue }
    want = real ? today : gitDate(rel) || mtimeDate(file)
    lines.push('', `<sub><span style="color:#999">最后更新：${want}</span></sub>`)
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  changed++
}

if (checkOnly) {
  if (missing.length) { console.error(`缺少更新时间注解 ${missing.length} 篇：`); for (const x of missing) console.error('  ' + x) }
  if (outdated.length) { console.error(`有实质改动但注解不是今天 ${outdated.length} 篇：`); for (const x of outdated) console.error('  ' + x) }
  if (missing.length || outdated.length) process.exit(1)
  console.log(`GUIDE 更新时间注解齐全且新鲜（${files.length} 篇）`)
} else {
  console.log(`GUIDE 更新时间注解：${files.length} 篇，写入 ${changed} 篇`)
}
