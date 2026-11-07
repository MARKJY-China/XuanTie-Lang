// scripts/build-offline.mjs —— 离线文档包（md / web / ai 三份 zip）
//
// 为什么单独打三种包：
//   md  ：只有 markdown，给离线阅读器 / 二次分发；
//   web ：真空站（相对路径构建，解压后双击 index.html 即可），没网也能看；
//   ai  ：纯文本镜像（all.txt + 每篇 <pre>），给本地大模型/检索用。
// 三份包内容全部来自 synced GUIDE 与构建产物，不手写任何文档。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(SITE, '..')
const STAGE = join(ROOT, 'temp', 'offline-stage')
const OUT = join(SITE, 'offline-docs')
const DIST = join(SITE, '.vitepress', 'dist')

const run = (cmd, args, cwd = SITE) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: true })

function zipDir(src, outZip, nameInZip) {
  mkdirSync(OUT, { recursive: true })
  rmSync(outZip, { force: true })
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${src}\\*' -DestinationPath '${outZip}' -Force`], ROOT)
  } else {
    run('bash', ['-lc', `cd '${src}' && zip -qr '${outZip}' .`], ROOT)
  }
  console.log(`离线包: ${nameInZip} → ${outZip}`)
}

function main() {
  console.log('⓪ 同步 GUIDE → site/guide')
  run(process.execPath, ['scripts/sync-docs.mjs'])

  console.log('① 生成 AI 文档层 + 构建站点（相对路径，供离线双击打开）')
  run(process.execPath, ['scripts/build-ai-docs.mjs'])
  run('npx', ['vitepress', 'build', '--base', './'])
  run(process.execPath, ['scripts/postbuild-clean-urls.mjs'])

  rmSync(STAGE, { recursive: true, force: true })

  // md 包
  const mdStage = join(STAGE, 'md')
  mkdirSync(join(mdStage, 'guide'), { recursive: true })
  cpSync(join(SITE, 'guide'), join(mdStage, 'guide'), { recursive: true })
  if (existsSync(join(ROOT, 'versionLog.md'))) cpSync(join(ROOT, 'versionLog.md'), join(mdStage, 'versionLog.md'))
  writeFileSync(join(mdStage, 'README.md'), [
    '# 玄铁离线文档（Markdown）',
    '',
    '本包为玄铁官方文档的 markdown 源文件，目录结构与文档站一致。',
    '',
    '- 人类阅读：用任意 markdown 阅读器打开 `guide/玄铁语言参考手册.md`；',
    '- 文档站：https://xuantie.markjy.com/',
    '- 源码仓库：https://github.com/MARKJY-China/XuanTie-Lang',
    '',
  ].join('\n'), 'utf8')
  zipDir(mdStage, join(OUT, 'xuantie-docs-md.zip'), 'md')

  // web 包
  const webStage = join(STAGE, 'web')
  mkdirSync(webStage, { recursive: true })
  cpSync(DIST, webStage, { recursive: true })
  zipDir(webStage, join(OUT, 'xuantie-docs-web.zip'), 'web')

  // ai 包
  const aiStage = join(STAGE, 'ai')
  mkdirSync(aiStage, { recursive: true })
  const aiSrc = join(SITE, 'public', 'ai')
  if (existsSync(aiSrc)) cpSync(aiSrc, aiStage, { recursive: true })
  zipDir(aiStage, join(OUT, 'xuantie-docs-ai.zip'), 'ai')

  rmSync(STAGE, { recursive: true, force: true })
  console.log(`完成：三个包在 ${OUT}`)
}

main()
