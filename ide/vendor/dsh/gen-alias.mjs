// 生成 包名 → packages/<dir>/src 的 alias 清单(alias.json),供 build.mjs 使用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const alias = {}
for (const d of fs.readdirSync(`${root}/packages`)) {
  const pkg = JSON.parse(fs.readFileSync(`${root}/packages/${d}/package.json`, 'utf8'))
  alias[pkg.name] = `${root}/packages/${d}/src`
}
fs.writeFileSync(`${root}/alias.json`, JSON.stringify(alias, null, 2))
console.log(`alias.json: ${Object.keys(alias).length} packages`)
