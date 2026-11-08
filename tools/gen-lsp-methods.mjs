// tools/gen-lsp-methods.mjs —— 生成 LSP 的「字/字节/数组/字典」方法补全表
//
// 背景:在 净文./原文./词. 这类字符串变量后面补全时,LSP 没有类型推断也没有方法表,
// 落到「全局库成员兜底」,倒出一堆库成员(T._是分隔 等),而不是 替换/分割/去首尾空格。
//
// 数据来源:
//   字 / 字节 —— GUIDE/关键字/{字符串,字节}.md 的表格(与文档同源,防漂移);
//   数组 / 字典 —— 文档是散文式列举,这里按 数组.md / 字典.md 的方法清单静态维护。
//
// 生成区标记在 lsp/xt_lsp.xt,勿手改生成区。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LSP = join(ROOT, 'lsp', 'xt_lsp.xt')
const START = '// <<LSP方法表 生成区开始'
const END = '// <<LSP方法表 生成区结束>>'

// XTC 字符串里只保留安全字符:去掉双引号与反斜杠转义,避免生成的内联字面量被词法截断
const esc = (s) => String(s).replace(/[“”"]/g, '「').replace(/\\/g, '/').replace(/\r?\n/g, ' ').trim()

// 从关键字文档的表格里抽「接收者.方法(...)」:接收者占位符随文档而异(s./b. 等),
// 表列数也不统一(字符串.md 是「成员|说明」,字节.md 是「调用|返回|说明」)——按竖线切格,
// 首格取全部反引号片段,末格当说明。
function parseTable(type, file) {
  const out = new Map()
  const lines = readFileSync(join(ROOT, 'GUIDE', '关键字', file), 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map((s) => s.trim())
    if (cells.length < 2) continue
    const callCell = cells[0]
    const desc = cells[cells.length - 1]
    const calls = [...callCell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    for (const call of calls) {
      const dot = call.indexOf('.')
      if (dot <= 0) continue
      const rest = call.slice(dot + 1)
      const member = rest.split('(')[0].trim()
      if (!member) continue
      const isConst = !rest.includes('(')
      if (!out.has(member)) out.set(member, { desc, isConst })
    }
  }
  return out
}

// 数组/字典:文档无表格,按 数组.md「追加/删/插/找/含?/连接」与 字典.md「获取/包含?/键集/值集/删」维护
const STATIC = {
  数组: [
    ['追加', false, '尾部追加一个元素'],
    ['删', false, '按下标删除元素'],
    ['插', false, '按下标插入元素'],
    ['找', false, '查找元素下标,找不到 -1'],
    ['含?', false, '是否包含某元素,返回布尔'],
    ['连接', false, '与另一数组拼接,返回新数组'],
    ['长度', true, '元素个数'],
  ],
  字典: [
    ['获取', false, '按键取值;键不存在返回 空'],
    ['包含?', false, '是否含某键,返回布尔'],
    ['键集', true, '全部键组成的数组(也可属性写法 典.键集)'],
    ['值集', true, '全部值组成的数组(也可属性写法 典.值集)'],
    ['删', false, '按键删除条目'],
    ['长度', true, '条目个数'],
  ],
}

const tables = {
  字: parseTable('字', '字符串.md'),
  字节: parseTable('字节', '字节.md'),
}
for (const [type, items] of Object.entries(STATIC)) {
  tables[type] = new Map(items.map(([name, isConst, desc]) => [name, { desc, isConst }]))
}

const typeOrder = ['字', '字节', '数组', '字典']
const out = []
out.push(`${START}(由 tools/gen-lsp-methods.mjs 从 GUIDE/关键字 生成,勿手改)>>`)
out.push('设 方法表 = {')
for (const t of typeOrder) {
  const rows = [...tables[t]].map(([name, v]) => `"${esc(name)}": "${esc(v.desc)}"`)
  out.push(`    "${t}": {${rows.join(', ')}},`)
}
out.push('}')
const consts = []
for (const t of typeOrder) {
  const cs = [...tables[t]].filter(([, v]) => v.isConst).map(([n]) => '"' + esc(n) + '"')
  if (cs.length) consts.push(`"${t}": {${cs.map((c) => `${c}: 真`).join(', ')}}`)
}
out.push('设 方法常量 = {' + consts.join(', ') + '}')
out.push(END)

const src = readFileSync(LSP, 'utf8')
const si = src.indexOf(START)
const ei = src.indexOf(END)
if (si < 0 || ei < 0) {
  console.error('未找到方法表生成区标记')
  process.exit(1)
}
const updated = src.slice(0, si) + out.join('\n') + src.slice(ei + END.length)
writeFileSync(LSP, updated, 'utf8')
console.log(`已生成方法表:${typeOrder.map((t) => `${t} ${tables[t].size}`).join(' / ')}`)
