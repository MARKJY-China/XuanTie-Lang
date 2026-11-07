// 构建后处理：为每个页面额外产出「目录式」入口（xxx.html → xxx/index.html）
//
// 为什么需要它
// ------------
// 站点开了 cleanUrls，站内链接是 /downloads、/guide/关键字/异步 这种不带 .html 的形式，
// 而 VitePress 产物只有 downloads.html。若服务器没为 cleanUrls 配 try_files，
// 访问 /downloads 会命中「SPA 回退到 /index.html」——浏览器拿到的是首页 HTML，
// 客户端再按 location.pathname=/downloads 水合，于是出现"首页外壳 + 下载页内容"的错乱页
// （实测故障，2026-10）。
//
// 补上 xxx/index.html 后，/downloads 在 nginx/openresty 与各家静态托管上都会走
// 「目录 → 目录内 index.html」的标准解析，硬刷新/直达都能命中正确页面；
// 即使服务器配了 try_files $uri $uri.html ...，优先命中的仍是 downloads.html，无副作用。
//
// 已带目录的页（ide/index.html 这类）与 404.html、根 index.html 自动跳过。
import { readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(SITE, '.vitepress', 'dist')
const SKIP = new Set(['index.html', '404.html'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.html')) out.push(p)
  }
  return out
}

let copied = 0
for (const file of walk(DIST)) {
  const name = basename(file)
  if (SKIP.has(name)) continue
  const targetDir = join(dirname(file), name.slice(0, -5))
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(file, join(targetDir, 'index.html'))
  copied++
}

console.log(`[clean-urls] 已生成 ${copied} 个目录式入口（xxx/index.html）`)
