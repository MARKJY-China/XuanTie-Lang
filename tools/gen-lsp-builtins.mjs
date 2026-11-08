// tools/gen-lsp-builtins.mjs —— 用 GUIDE/关键字 的成员表生成 LSP 的内置库成员表
//
// 背景:LSP 的 `数学.` / `时.` / `文件.` 补全靠 xt_lsp.xt 里的静态表;手抄必然与文档漂移
// (实测 时 缺 部分/格式/指定/间隔,系统 整个命名空间缺失)。这里从关键字文档表格
// `| `模块.成员(...)` | 返回 | 说明 |` 直接生成,生成区用标记包住,勿手改。
//
// 用法:node tools/gen-lsp-builtins.mjs [--check]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KW = join(ROOT, 'GUIDE', '关键字')
const LSP = join(ROOT, 'lsp', 'xt_lsp.xt')
const START = '// <<LSP内置库成员 生成区开始'
const END = '// <<LSP内置库成员 生成区结束>>'
const PRIORITY = ['时', '文件', '数学', '系统', '网络', '通道', '线程', '池', '字符', '数组', '字典']

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim()

function main() {
  const mods = new Map()
  for (const name of readdirSync(KW)) {
    if (!name.endsWith('.md')) continue
    const mod = name.slice(0, -3)
    const lines = readFileSync(join(KW, name), 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const m = line.trim().match(/^\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*$/)
      if (!m) continue
      const call = m[1].trim()
      const dot = call.indexOf('.')
      if (dot <= 0) continue
      const ns = call.slice(0, dot)
      if (ns !== mod) continue // 只收「本命名空间」的成员,避免把别的模块行算进来
      const rest = call.slice(dot + 1)
      const member = rest.split('(')[0].trim()
      if (!member) continue
      const desc = m[3].trim()
      const isConst = !rest.includes('(') && !member.endsWith('?')
      if (!mods.has(ns)) mods.set(ns, { members: new Map(), consts: new Set() })
      mods.get(ns).members.set(ns + '.' + member, desc)
      if (isConst) mods.get(ns).consts.add(ns + '.' + member)
    }
  }

  const names = [...mods.keys()].sort((a, b) => {
    const ia = PRIORITY.indexOf(a), ib = PRIORITY.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh')
  })
  const out = []
  out.push(`${START}(由 tools/gen-lsp-builtins.mjs 从 GUIDE/关键字/*.md 生成,勿手改)>>`)
  out.push('设 内置空间名 = [' + names.map((n) => `"${n}"`).join(', ') + ']')
  out.push('设 内置库成员 = {')
  const lines = []
  for (const ns of names) {
    for (const [key, desc] of mods.get(ns).members) lines.push(`    "${esc(key)}": "${esc(desc)}",`)
  }
  out.push(...lines)
  out.push('}')
  const consts = []
  for (const ns of names) for (const k of mods.get(ns).consts) consts.push(`"${esc(k)}": 真`)
  out.push('设 内置库常量 = {' + consts.join(', ') + '}')
  out.push(END)

  const src = readFileSync(LSP, 'utf8')
  const si = src.indexOf(START)
  const ei = src.indexOf(END)
  if (si < 0 || ei < 0) {
    console.error('未找到生成区标记,请先手动加标记')
    process.exit(1)
  }
  const updated = src.slice(0, si) + out.join('\n') + src.slice(ei + END.length)
  if (process.argv.includes('--check')) {
    if (updated !== src) { console.error('LSP 内置库成员表与文档不一致,请运行 node tools/gen-lsp-builtins.mjs'); process.exit(1) }
    console.log('LSP 内置库成员表与文档一致')
    return
  }
  writeFileSync(LSP, updated, 'utf8')
  const total = lines.length
  console.log(`已生成 ${names.length} 个命名空间 / ${total} 个成员(${names.join('、')})`)
}

main()
