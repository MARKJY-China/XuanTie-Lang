#!/usr/bin/env node
// tools/gen-api.mjs —— 从 lib/*/*.xt 生成 API 参考（GUIDE/API/）
//
// 用法：node tools/gen-api.mjs [--out <目录>]
// 输出：GUIDE/API/{README,语言内建,<库>}.md + index.json
//
// ── 注释约定（写库的人按这个写，生成器自动排版）────────────────────────────
//   // 一句话或多行说明（可空行分段，站点上保留换行，不塌成一行）
//   //
//   // 参数 键: 字符串 — 动画键名
//   // 参数 目标: 小数 — 目标值
//   // 返回: 小数 — 当前插值
//
//   - `// ==== 名称 ====` 或三行式（分隔线/名称/分隔线）作为小节标题，会变成二级标题；
//   - 分隔线本身不会进入说明文字；
//   - 没有参数/返回行时，参数表按签名里的形参自动列出（类型与说明留 —），返回行省略。
//
// 识别规则：
//   * 公开函数：行首 `公 函 名(...)`；若该文件一个 `公 函` 都没有（数组/SQLite 风格），
//     则把所有顶层 `函 名(...)` 当公开 API。
//   * 公开常量/变量：`公 常 名 = 值` / `公 设 名 = 值`。
//   * 语言内建分组来自 tools/api-categories.json；说明取 GUIDE/关键字/<名>.md 首段。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const OUT = outArg >= 0 ? resolve(args[outArg + 1]) : join(ROOT, 'GUIDE', 'API')

const CONFIG = JSON.parse(readFileSync(join(ROOT, 'tools', 'api-categories.json'), 'utf8'))

const SEP_ONLY_RE = /^\/\/\s*[=\-─\s]+$/
const INLINE_SECTION_RE = /^\/\/\s*[=\-─]{3,}\s*([^=\-─]+?)\s*[=\-─]{3,}\s*$/
const PARAM_RE = /^参数\s*[:：]?\s*([^\s:：]+)\s*[:：]\s*([^\s—–-]+)?\s*(?:[—–-]\s*(.*))?$/
const RETURN_RE = /^返回\s*[:：]?\s*([^\s—–-]+)?\s*(?:[—–-]\s*(.*))?$/
const FUNC_PUB_RE = /^公\s+函\s+([^\s(（]+)\s*[(（]([^)）]*)[)）]/
const FUNC_BARE_RE = /^函\s+([^\s(（]+)\s*[(（]([^)）]*)[)）]/
const CONST_PUB_RE = /^公\s+(?:设|常)\s+([^\s=]+)\s*=\s*(.*)$/

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

// 三行式小节：分隔线 / 名称 / 分隔线
function threeLineTitleAt(lines, i) {
  if (i + 2 >= lines.length) return null
  if (!SEP_ONLY_RE.test(lines[i].trim())) return null
  if (!SEP_ONLY_RE.test(lines[i + 2].trim())) return null
  const mid = lines[i + 1].trim()
  if (SEP_ONLY_RE.test(mid)) return null
  const t = mid.replace(/^\/\/\s?/, '').trim()
  return t || null
}

function currentSection(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const t = lines[i].trim()
    const m = t.match(INLINE_SECTION_RE)
    if (m) return m[1].trim()
    if (SEP_ONLY_RE.test(t)) {
      const s = threeLineTitleAt(lines, i)
      if (s) return s
    }
  }
  return '其他'
}

// 解析紧贴声明的注释块（连续 // 行）
function parseDoc(lines, idx) {
  const raw = []
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '') break
    if (/^\/\//.test(t)) { raw.unshift(t); continue }
    break
  }
  if (!raw.length) return { paragraphs: [], params: [], ret: null }

  const body = []
  const params = []
  let ret = null
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k]
    if (SEP_ONLY_RE.test(line)) continue
    if (INLINE_SECTION_RE.test(line)) continue
    if (threeLineTitleAt(raw, k)) { k += 2; continue }
    const t = line.replace(/^\/\/\s?/, '').trim()
    let m = t.match(PARAM_RE)
    if (m) {
      params.push({ name: m[1], type: (m[2] || '').trim(), desc: (m[3] || '').trim() })
      continue
    }
    m = t.match(RETURN_RE)
    if (m && (m[1] || m[2])) {
      ret = { type: (m[1] || '').trim(), desc: (m[2] || '').trim() }
      continue
    }
    body.push(t)
  }
  // 空行分段：连续的 '//' 空行切段
  const paragraphs = []
  let cur = []
  for (const text of body) {
    if (text === '') {
      if (cur.length) { paragraphs.push(cur.join('\n')); cur = [] }
    } else cur.push(text)
  }
  if (cur.length) paragraphs.push(cur.join('\n'))
  return { paragraphs, params, ret }
}

function parseLib(libDir) {
  const items = []
  for (const file of walkXt(libDir)) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const hasPub = lines.some((l) => FUNC_PUB_RE.test(l))
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]
      const m = (hasPub ? t.match(FUNC_PUB_RE) : null) || (!hasPub ? t.match(FUNC_BARE_RE) : null)
      if (m) {
        const doc = parseDoc(lines, i)
        items.push({
          kind: 'func', name: m[1], paramsText: m[2].trim(),
          paragraphs: doc.paragraphs, params: doc.params, ret: doc.ret,
          section: currentSection(lines, i), file: rel, line: i + 1,
        })
        continue
      }
      const c = t.match(CONST_PUB_RE)
      if (c) {
        const doc = parseDoc(lines, i)
        items.push({
          kind: 'const', name: c[1], value: c[2].trim().replace(/,\s*$/, ''),
          paragraphs: doc.paragraphs, params: [], ret: null,
          section: currentSection(lines, i), file: rel, line: i + 1,
        })
      }
    }
  }
  return items
}

function sigOf(it, alias) {
  if (it.kind !== 'func') return `${alias}.${it.name}`
  return `${alias}.${it.name}(${it.paramsText})`
}

function paramNamesOf(it) {
  if (!it.paramsText.trim()) return []
  return it.paramsText.split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)
}

function renderFunc(it, alias) {
  const out = []
  out.push(`### \`${sigOf(it, alias)}\``)
  out.push('')
  if (it.paragraphs.length) {
    for (const p of it.paragraphs) { out.push(p); out.push('') }
  } else {
    out.push('（源码中该函数上方无注释）')
    out.push('')
  }
  const names = paramNamesOf(it)
  const meta = new Map(it.params.map((p) => [p.name, p]))
  if (names.length || it.params.length) {
    out.push('**参数**')
    out.push('')
    out.push('| 参数 | 类型 | 说明 |')
    out.push('|---|---|---|')
    const order = names.length ? names : it.params.map((p) => p.name)
    for (const n of order) {
      const p = meta.get(n) || {}
      out.push(`| \`${n}\` | ${p.type || '—'} | ${p.desc || '—'} |`)
    }
    for (const p of it.params) if (!order.includes(p.name)) out.push(`| \`${p.name}\` | ${p.type || '—'} | ${p.desc || '—'} |`)
    out.push('')
  }
  if (it.ret) {
    out.push(`**返回**：${it.ret.type || '—'}${it.ret.desc ? ' — ' + it.ret.desc : ''}`)
    out.push('')
  }
  return out
}

function esc(s) { return String(s).replace(/\|/g, '\\|') }

function renderLib(libName, version, items, alias) {
  const funcs = items.filter((x) => x.kind === 'func')
  const consts = items.filter((x) => x.kind === 'const')
  const title = (CONFIG.libTitles && CONFIG.libTitles[libName]) || libName
  const out = []
  out.push(`# ${title} API 参考`)
  out.push('')
  out.push(`> 对标版本：${version ? 'v' + version : '（未标注）'} ｜ 来源：\`lib/${libName}/\` 共 ${funcs.length} 个公开函数${consts.length ? `、${consts.length} 个公开常量/变量` : ''}`)
  out.push('')
  out.push(`导入：\`引 "${libName}" 予 ${alias}\`；下表签名里的 \`${alias}.\` 即该库别名。`)
  out.push('')
  const bySection = new Map()
  for (const it of items) {
    const s = it.section || '其他'
    if (!bySection.has(s)) bySection.set(s, { funcs: [], consts: [] })
    bySection.get(s)[it.kind === 'func' ? 'funcs' : 'consts'].push(it)
  }
  for (const [rawSection, g] of bySection) {
    // 小库没有小节标题：统一显示为「公开函数」，不出现「其他」
    const section = rawSection === '其他' ? '公开函数' : rawSection
    out.push(`## ${section}`)
    out.push('')
    for (const it of g.funcs) out.push(...renderFunc(it, alias))
    if (g.consts.length) {
      out.push('**常量 / 变量**')
      out.push('')
      out.push('| 名称 | 值 | 说明 |')
      out.push('|---|---|---|')
      for (const c of g.consts) {
        out.push(`| \`${alias}.${c.name}\` | \`${esc(c.value)}\` | ${esc(c.paragraphs.join(' ')) || '—'} |`)
      }
      out.push('')
    }
  }
  return out.join('\n')
}

// ── 语言内建页：分类来自配置，说明取关键字文档首段 ──
function keywordSummary(name) {
  const p = join(ROOT, 'GUIDE', '关键字', name + '.md')
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').split(/\r?\n/)
  let i = 0
  while (i < lines.length && !/^#\s+/.test(lines[i])) i++
  i++
  const buf = []
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '') { if (buf.length) break; else continue }
    if (/^[#>`|]/.test(t)) { if (buf.length) break; else continue }
    buf.push(t)
  }
  return buf.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

function renderBuiltins() {
  const cats = CONFIG.builtinCategories || {}
  const out = []
  out.push('# 语言内建 API')
  out.push('')
  out.push('> 语言自带的关键词与内建函数（不需要 `引` 任何库）。库 API 见 [API 总览](./README)。')
  out.push('')
  for (const [cat, names] of Object.entries(cats)) {
    out.push(`## ${cat}`)
    out.push('')
    out.push('| 关键词 | 说明 | 详见 |')
    out.push('|---|---|---|')
    for (const n of names) {
      const sum = keywordSummary(n)
      const link = sum ? `[\`${n}\`](../关键字/${n})` : `\`${n}\``
      out.push(`| \`${n}\` | ${esc(sum || '（暂无关键字文档）')} | ${link} |`)
    }
    out.push('')
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
  if (!items.length) { console.log(`跳过 ${libName}（未发现公开声明）`); continue }
  const version = readVersion(libDir)
  const alias = aliasOf(libName)
  writeFileSync(join(OUT, `${libName}.md`), renderLib(libName, version, items, alias), 'utf8')
  index.libs.push({
    name: libName, title: (CONFIG.libTitles || {})[libName] || libName, version, alias,
    functions: items.filter((x) => x.kind === 'func').length,
    consts: items.filter((x) => x.kind === 'const').length,
    items,
  })
  console.log(`生成 ${libName}.md（${items.length} 条）`)
}

writeFileSync(join(OUT, '语言内建.md'), renderBuiltins(), 'utf8')
console.log('生成 语言内建.md')

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2), 'utf8')

const readme = []
readme.push('# API 参考')
readme.push('')
readme.push('> 由 `tools/gen-api.mjs` 从源码与关键字文档自动生成，请勿手改。要改说明：库函数改上方注释，语言内建改 `GUIDE/关键字/*.md`。')
readme.push('')
readme.push('## 语言内建')
readme.push('')
readme.push('流程控制、线程与并发、异常处理、输入输出、网络、文件、数学、类型转换等语言自带关键词：见 [语言内建 API](./语言内建)。')
readme.push('')
readme.push('## 库 API')
readme.push('')
readme.push('| 库 | 版本 | 公开函数 | 公开常量/变量 |')
readme.push('|---|---|---|---|')
for (const l of index.libs) {
  readme.push(`| [${l.title}](./${l.name}) | ${l.version ? 'v' + l.version : '—'} | ${l.functions} | ${l.consts} |`)
}
readme.push('')
readme.push('运行时函数签名与实现见 [标准库与 Runtime API](../手册/06_标准库与RuntimeAPI)。')
writeFileSync(join(OUT, 'README.md'), readme.join('\n'), 'utf8')
console.log(`完成：${index.libs.length} 个库 → ${OUT}`)
