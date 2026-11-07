// scripts/build-site.mjs — 站点构建统一入口
//
// 为什么单列一个脚本：docs:build 原本是 `node sync && vitepress build && node postbuild`
// 这样的 shell 链，而 npm 追加的参数只会落到**最后一条命令**上。于是
//   npm run docs:build -- --base=/docs/
// 里的 --base 会被补入口脚本吃掉，vitepress 仍按 '/' 构建 —— 离线包丢到子路径时全站 404。
// 这里显式把参数转发给 vitepress build。
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const extra = process.argv.slice(2)
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: SITE, stdio: 'inherit', shell: true })

console.log('① 同步 GUIDE/ → site/guide')
run('node', ['scripts/sync-docs.mjs'])

console.log('①.5 生成 AI 文档层（/ai/）')
run('node', ['scripts/build-ai-docs.mjs'])

console.log('② 构建站点' + (extra.length ? `（${extra.join(' ')}）` : ''))
run('npx', ['vitepress', 'build', ...extra])

console.log('③ 补目录式入口（cleanUrls 兜底）')
run('node', ['scripts/postbuild-clean-urls.mjs'])
