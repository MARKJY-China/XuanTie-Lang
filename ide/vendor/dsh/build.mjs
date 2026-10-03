// DSH 核心链浏览器 bundle 构建:facade.ts → dist/dsh-core.mjs
// 平台 browser + 7 个 node:* shim;非 minify(vite 在 IDE 构建期处理)。
// 依赖(esbuild/zod/@standard-schema/spec)在 ide 根 package.json 的 devDependencies。
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
if (!fs.existsSync(`${root}/alias.json`)) {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [`${root}/gen-alias.mjs`], { stdio: 'inherit' })
}
const alias = JSON.parse(fs.readFileSync(`${root}/alias.json`, 'utf8'))

const result = await build({
  entryPoints: [`${root}/facade.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome105',
  minify: false,
  outfile: `${root}/dist/dsh-core.mjs`,
  alias: {
    ...alias,
    'node:crypto': `${root}/shims/crypto.ts`,
    'node:async_hooks': `${root}/shims/async_hooks.ts`,
    'node:util/types': `${root}/shims/util-types.ts`,
    'node:path': `${root}/shims/path.ts`,
    'node:module': `${root}/shims/module.ts`,
    'node:fs': `${root}/shims/fs.ts`,
    'node:os': `${root}/shims/os.ts`,
  },
  logLevel: 'info',
})
if (result.errors.length > 0) process.exit(1)
