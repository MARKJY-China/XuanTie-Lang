#!/usr/bin/env node
// tools/check-lib-versions.mjs —— 按契约 lib-version-discipline 校验库版本三处口径
//
// 用法：node tools/check-lib-versions.mjs
// 退出码：0 = 全部一致；1 = 有违规；2 = 契约/文件缺失，无法校验
//
// 规则（契约 lib-version-discipline v3）：
//   真源 = lib/<库>/tiepm.toml 的 `版本 = "x.y.z"`；
//   headerRequired 的库：源文件头注释里必须出现 vX.Y.Z 且与真源一致；
//   有 changelog 的库：顶部第一个 `## vX.Y.Z` 必须与真源一致。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = join(ROOT, 'xt-ecosystem', 'contracts', 'lib-version-discipline.json')

if (!existsSync(CONTRACT)) {
  console.error(`[版本校验] 找不到契约：${CONTRACT}`)
  console.error('[版本校验] 主仓库不跟踪 xt-ecosystem/，请先检出契约仓库后再跑本脚本。')
  process.exit(2)
}

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
const manifestRe = new RegExp(contract.patterns.manifest, 'm')
const headerRe = new RegExp(contract.patterns.header)
const changelogRe = new RegExp(contract.patterns.changelog, 'm')

let bad = 0
let checked = 0

for (const lib of contract.libs) {
  const dir = join(ROOT, lib.dir)
  const manifestPath = join(dir, lib.manifest)
  if (!existsSync(manifestPath)) {
    console.error(`[版本校验] ${lib.id}: 缺清单 ${lib.dir}/${lib.manifest}`)
    bad++
    continue
  }
  const manifest = readFileSync(manifestPath, 'utf8')
  const m = manifest.match(manifestRe)
  if (!m) {
    console.error(`[版本校验] ${lib.id}: tiepm.toml 里找不到 版本 = "x.y.z"`)
    bad++
    continue
  }
  const version = m[1]
  checked++

  const problems = []
  if (lib.entry) {
    const entryPath = join(dir, lib.entry)
    if (!existsSync(entryPath)) {
      problems.push(`缺入口文件 ${lib.dir}/${lib.entry}`)
    } else if (lib.headerRequired) {
      const head = readFileSync(entryPath, 'utf8').split(/\r?\n/).slice(0, 5).join('\n')
      const hm = head.match(headerRe)
      if (!hm) problems.push('源文件头未声明 vX.Y.Z（headerRequired=true）')
      else if (hm[1] !== version) problems.push(`源文件头 v${hm[1]} ≠ 清单 v${version}`)
    }
  }

  if (lib.changelog) {
    const clPath = join(dir, lib.changelog)
    if (!existsSync(clPath)) {
      problems.push(`缺 changelog ${lib.dir}/${lib.changelog}`)
    } else {
      const text = readFileSync(clPath, 'utf8')
      const cm = text.match(changelogRe)
      if (!cm) problems.push('changelog 顶部没有 ## vX.Y.Z 节')
      else if (cm[1] !== version) problems.push(`changelog v${cm[1]} ≠ 清单 v${version}`)
    }
  }

  if (problems.length) {
    bad++
    console.error(`[版本校验] ${lib.id}: v${version} 不一致`)
    for (const p of problems) console.error(`  - ${p}`)
  } else {
    console.log(`[版本校验] ${lib.id}: v${version} ✓`)
  }
}

console.log(`---\n[版本校验] 共 ${checked} 个库，违规 ${bad} 个`)
process.exit(bad ? 1 : 0)
