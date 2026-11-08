// scripts/sync-docs.mjs — 把仓库 GUIDE/ 同步进站点（单一内容源）
//
// 同步范围：GUIDE 根级白名单 + 关键字/UI/手册/例程/API 子目录（递归）。
// 同时做三件"上站即需要"的改写：
//   1) 仓库内相对链接 → GitHub blob（站内没有的文件会被点成 404，改指源码）；
//   2) ```text 围栏 → ```xuantie，让站内用上玄铁语法高亮；
//   3) 仓库资源 assets/ 与语法文件 tmLanguage 复制到站点。
// 源文件本身不动（GUIDE 保持可离线阅读的相对链接），改写只发生在站点副本上。

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(SITE, '..')
const GUIDE = join(ROOT, 'GUIDE')
const OUT = join(SITE, 'guide')
const GITHUB_BLOB = 'https://github.com/MARKJY-China/XuanTie-Lang/blob/master/'

// 根级白名单：只把这些上站（内部计划/待办类文档不上公开站）
const ROOT_FILES = [
  '玄铁语言参考手册.md',
  '01_结果类型与错误处理.md',
  '02_类型系统哲学设计.md',
  '03_泛型编程指南.md',
  '04_弱引用编程指南.md',
  '05_模块系统.md',
  '06_数组编程指南.md',
  '07_铁铺使用指南.md',
  '08_网络与并发编程指南.md',
  '09_渲染库编程指南.md',
  '10_运算符重载编程指南.md',
  '11_多线程开发深度教程.md',
  '12_UI库编程指南.md',
  '13_文本库编程指南.md',
  '14_路径库编程指南.md',
  '15_数据结构库编程指南.md',
  '离线文档.md',
  '种子编译器实现笔记.md',
  '自举编译器实现笔记.md',
  '铁铺设计笔记.md',
]
const INCLUDE_DIRS = ['关键字', 'UI', '手册', '例程', 'API']

const linkMisses = new Map()

function isPublished(relToRoot) {
  if (ROOT_FILES.includes(relToRoot)) return true
  return INCLUDE_DIRS.some((d) => relToRoot.startsWith(d + '/'))
}

function rewriteLinks(md, srcDir) {
  return md.replace(/\]\(((?:\.\/|\.\.\/)[^)\s]+)\)/g, (m, target) => {
    const hashIdx = target.indexOf('#')
    const rel = hashIdx >= 0 ? target.slice(0, hashIdx) : target
    const frag = hashIdx >= 0 ? target.slice(hashIdx) : ''
    let abs = resolve(srcDir, rel)
    // 站内链接可省略 .md（VitePress 约定）：存在性判定补扩展名/目录索引
    if (!abs.endsWith('.md') && existsSync(abs + '.md')) abs += '.md'
    if (existsSync(abs) && statSync(abs).isDirectory() && existsSync(join(abs, 'index.md'))) abs = join(abs, 'index.md')
    const relToRoot = relative(ROOT, abs).replace(/\\/g, '/')
    const relGuide = relToRoot.startsWith('GUIDE/') ? relToRoot.slice('GUIDE/'.length) : relToRoot
    if (!existsSync(abs)) {
      linkMisses.set(relToRoot + frag, (linkMisses.get(relToRoot + frag) || 0) + 1)
      return m
    }
    if (relToRoot === 'versionLog.md') return m
    if (isPublished(relGuide)) return m
    return `](${GITHUB_BLOB}${encodeURI(relToRoot + frag)})`
  })
}

function rewriteFences(md) {
  return md.replace(/^```text\s*$/gm, '```xuantie')
}

// Vue 会把 markdown 里的 {{ … }} 当作插值表达式编译（构建直接报 SyntaxError）。
// 文档里 `{{` / `}}` 是在讲转义语法，属于字面量：换成带 v-pre 的 <code> 让 Vue 跳过。
function escapeVueInterp(md) {
  return md
    .replace(/`\{\{`/g, '<code v-pre>{{</code>')
    .replace(/`\}\}`/g, '<code v-pre>}}</code>')
}

function writeDoc(dest, md) {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, escapeVueInterp(rewriteFences(rewriteLinks(md, join(ROOT, 'GUIDE')))), 'utf8')
}

function main() {
  // 先跑 API 参考生成器（GUIDE/API 是生成物，供同步与离线包复用）
  const genApi = join(ROOT, 'tools', 'gen-api.mjs')
  if (existsSync(genApi)) {
    try {
      execFileSync(process.execPath, [genApi], { stdio: 'inherit' })
    } catch (e) {
      console.warn('gen-api 生成失败（跳过 API 参考）:', e.message)
    }
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  let rootCount = 0
  for (const name of ROOT_FILES) {
    const src = join(GUIDE, name)
    if (!existsSync(src)) continue
    writeDoc(join(OUT, name), readFileSync(src, 'utf8'))
    rootCount++
  }

  let subCount = 0
  const walk = (dir, outDir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, e.name)
      const dest = join(outDir, e.name)
      if (e.isDirectory()) { walk(src, dest); continue }
      if (!e.name.endsWith('.md')) continue
      writeDoc(dest, readFileSync(src, 'utf8'))
      subCount++
    }
  }
  for (const d of INCLUDE_DIRS) {
    const src = join(GUIDE, d)
    if (existsSync(src)) walk(src, join(OUT, d))
  }

  // 站点资源：仓库 assets/ → public/assets；标识与语法文件放到站点根
  const assetsSrc = join(ROOT, 'assets')
  if (existsSync(assetsSrc)) {
    const assetsOut = join(SITE, 'public', 'assets')
    rmSync(assetsOut, { recursive: true, force: true })
    mkdirSync(assetsOut, { recursive: true })
    for (const f of readdirSync(assetsSrc)) {
      const p = join(assetsSrc, f)
      if (statSync(p).isFile()) copyFileSync(p, join(assetsOut, f))
    }
  }
  const seal = join(assetsSrc, '玄铁logo-玄印.svg')
  if (existsSync(seal)) copyFileSync(seal, join(SITE, 'public', 'seal.svg'))
  const grammar = join(ROOT, 'extensions', 'xuantie-syntax', 'syntaxes', 'xuantie.tmLanguage.json')
  if (existsSync(grammar)) copyFileSync(grammar, join(SITE, 'xuantie.tmLanguage.json'))

  // 版本日志：站点根页面由仓库 versionLog 维护；没有就放占位（避免侧边栏死链）
  const vlSrc = join(ROOT, 'versionLog.md')
  const vlOut = join(SITE, 'versionLog.md')
  if (existsSync(vlSrc)) copyFileSync(vlSrc, vlOut)
  else if (!existsSync(vlOut)) writeFileSync(vlOut, '# 更新日志\n\n> 见 GitHub Releases：https://github.com/MARKJY-China/XuanTie-Lang/releases\n', 'utf8')

  if (linkMisses.size) {
    console.warn('sync-docs: 警告——以下相对链接的目标文件不存在（源文档自身死链，请修源）：')
    for (const [k, v] of linkMisses) console.warn(`  ${k}: ${v} 处`)
  }
  console.log(`sync-docs: 根级 ${rootCount} 篇 + 子目录 ${subCount} 篇（${INCLUDE_DIRS.join('/')}，递归）`)
}

main()
