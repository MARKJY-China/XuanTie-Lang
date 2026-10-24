#!/usr/bin/env node
// tools/gen-api.mjs —— 从 lib/*/*.xt 生成 API 参考（GUIDE/API/）
//
// 用法：node tools/gen-api.mjs [--out <目录>]
// 输出：GUIDE/API/index.json、GUIDE/API/README.md、GUIDE/API/<库>.md
//
// 识别规则：
//   * 公开函数：行首 `公 函 名(...)`；若该文件一个 `公 函` 都没有（数组/SQLite 风格），
//     则把所有顶层 `函 名(...)` 当公开 API。
//   * 说明：紧贴函数上方连续的 `//` 注释（去掉小节分隔行）。
//   * 分组：源码里的 `// ==== 名称 ====` / `// ---- 名称 ----` 小节标题。
//
// 生成物默认不入库（.gitignore 已排除 GUIDE/API/），但会被离线包同步带走。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const OUT = outArg >= 0 ? resolve(args[outArg + 1]) : join(ROOT, 'GUIDE', 'API')

const SECTION_LOOSE_RE = /^\/\/\s*[=\-─]{3,}/
const COMMENT_RE = /^\/\/\s?(.*)$/

// 从 `// ==== 窗口 ====` 这类行里抽出标题；不是分节行返回 null
function sectionTitle(line) {
  const t = line.trim()
  if (!SECTION_LOOSE_RE.test(t)) return null
  const s = t
    .replace(/^\/\/\s*/, '')
    .replace(/^[=\-─\s]+/, '')
    .replace(/[=\-─\s]+$/, '')
    .trim()
  return s || null
}
const FUNC_PUB_RE = /^公\s+函\s+([^\s(（]+)\s*[(（]([^)）]*)[)）]/
const FUNC_BARE_RE = /^函\s+([^\s(（]+)\s*[(（]([^)）]*)[)）]/
const CONST_PUB_RE = /^公\s+(?:设|常)\s+([^\s=]+)/

function walkXt(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walkXt(p))
    else if (name.endsWith('.xt')) out.push(p)
  }
  return out
}

function readVersion(libDir) {
  const toml = join(libDir, 'tiepm.toml')
  if (!existsSync(toml)) return ''
  const m = readFileSync(toml, 'utf8').match(/^\s*版本\s*=\s*"([^"]+)"/m)
  return m ? m[1] : ''
}

// 取紧贴某行上方的连续注释（遇到空行或代码即停）
function trailingComment(line) {
  const i = line.indexOf('//')
  return i >= 0 ? line.slice(i + 2).trim() : ''
}

function leadingComment(lines, idx) {
  const buf = []
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '') break
    if (sectionTitle(t)) break
    const m = t.match(COMMENT_RE)
    if (!m) break
    buf.unshift(m[1].trim())
  }
  return buf.join(' ').trim()
}

function currentSection(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const s = sectionTitle(lines[i])
    if (s) return s
  }
  return '其他'
}

function parseLib(libDir) {
  const files = walkXt(libDir)
  const items = []
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const hasPub = lines.some((l) => FUNC_PUB_RE.test(l))
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]
      const m = (hasPub ? t.match(FUNC_PUB_RE) : null) || (!hasPub ? t.match(FUNC_BARE_RE) : null)
      if (m) {
        items.push({
          kind: 'func',
          name: m[1],
          params: m[2].trim(),
          summary: leadingComment(lines, i),
          section: currentSection(lines, i),
          file: rel,
          line: i + 1,
        })
        continue
      }
      const c = t.match(CONST_PUB_RE)
      if (c) {
        items.push({
          kind: 'const',
          name: c[1],
          params: '',
          summary: leadingComment(lines, i),
          section: currentSection(lines, i),
          file: rel,
          line: i + 1,
        })
      }
    }
  }
  return items
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function renderLib(libName, version, items, alias) {
  const funcs = items.filter((x) => x.kind === 'func')
  const consts = items.filter((x) => x.kind === 'const')
  const out = []
  out.push(`# ${libName} API 参考`)
  out.push('')
  out.push(`> 对标版本：${version ? 'v' + version : '（未标注）'} ｜ 来源：\`lib/${libName}/\` 共 ${funcs.length} 个公开函数${consts.length ? `、${consts.length} 个公开常量/变量` : ''}`)
  out.push('')
  out.push(`导入：\`引 "${libName}" 予 ${alias}\`，下表签名中的 \`${alias}.\` 即该库别名（也可用别的别名）。`)
  out.push('')
  const bySection = new Map()
  for (const it of items) {
    const s = it.section || '其他'
    if (!bySection.has(s)) bySection.set(s, [])
    bySection.get(s).push(it)
  }
  for (const [section, list] of bySection) {
    out.push(`## ${section}`)
    out.push('')
    for (const it of list) {
      const sig = it.kind === 'func' ? `${alias}.${it.name}(${it.params})` : `${alias}.${it.name}`
      out.push(`### \`${sig}\``)
      out.push('')
      if (it.summary) {
        out.push(it.summary)
        out.push('')
      } else if (it.kind === 'func') {
        out.push('（源码中该函数上方无注释）')
        out.push('')
      }
    }
  }
  return out.join('\n')
}

const aliasOf = (n) => ({ 渲染: 'R', UI: 'UI', HTTP: 'HTTP', SQLite: 'DB', 数组: '数组' }[n] || 'X')

const libRoot = join(ROOT, 'lib')
const libs = readdirSync(libRoot)
  .filter((n) => statSync(join(libRoot, n)).isDirectory())
  .sort((a, b) => a.localeCompare(b, 'zh'))

const index = { generated: new Date().toISOString(), libs: [] }
mkdirSync(OUT, { recursive: true })

for (const libName of libs) {
  const libDir = join(libRoot, libName)
  const items = parseLib(libDir)
  if (!items.length) {
    console.log(`跳过 ${libName}（未发现公开声明）`)
    continue
  }
  const version = readVersion(libDir)
  const alias = aliasOf(libName)
  writeFileSync(join(OUT, `${libName}.md`), renderLib(libName, version, items, alias), 'utf8')
  index.libs.push({
    name: libName,
    version,
    alias,
    functions: items.filter((x) => x.kind === 'func').length,
    consts: items.filter((x) => x.kind === 'const').length,
    items,
  })
  console.log(`生成 ${libName}.md（${items.length} 条）`)
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2), 'utf8')

const readme = []
readme.push('# API 参考')
readme.push('')
readme.push('> 由 `tools/gen-api.mjs` 从各库源码自动生成，请勿手改；要改说明请改库函数上方的注释。')
readme.push('')
readme.push('| 库 | 版本 | 公开函数 | 公开常量/变量 |')
readme.push('|---|---|---|---|')
for (const l of index.libs) {
  readme.push(`| [${l.name}](./${l.name}) | ${l.version ? 'v' + l.version : '—'} | ${l.functions} | ${l.consts} |`)
}
readme.push('')
readme.push('运行时内建（`示` / `输` / `执` / `数学.*` / `文件.*` 等）不在本参考内，见 [标准库与 Runtime API](../手册/06_标准库与RuntimeAPI) 与 [关键字速查](../关键字/)。')
writeFileSync(join(OUT, 'README.md'), readme.join('\n'), 'utf8')
console.log(`完成：${index.libs.length} 个库 → ${OUT}`)
