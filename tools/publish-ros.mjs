#!/usr/bin/env node
// tools/publish-ros.mjs —— 把发行包上传到雨云 ROS(S3 兼容),并生成「发布通道清单」。
//
// 通道清单是升级器的唯一真源(升级器只读清单,不查 GitHub API),通道与清单文件名一一对应。
// 四分支模型:develop=dev / master=rc / stable=stable / hotfix=P0 热修短分支(发布时复用 stable 通道):
//   stable(默认): latest.json      —— release.yml 在 v* tag 发布时调用(稳定版 + hotfix 补丁;预发布阶段 rc 也写它)
//   dev         : latest-dev.json  —— dev.yml 在 push develop 后调用;绝不触碰 latest.json
//   rc          : latest-rc.json   —— v1.0.0 之后的 rc tag 专用;绝不触碰 latest.json
//   hotfix      : 不单独出清单     —— 合回 stable 后打 v1.0.x tag,按 stable 通道写 latest.json(channel=stable)
//
// 用法:
//   node tools/publish-ros.mjs --dir release --version v1.0-rc.4 --channel stable
//   node tools/publish-ros.mjs --dir artifacts --version v1.0-rc.5-dev.20261119.f00e409 --channel dev
//   node tools/publish-ros.mjs --dir release --version v1.1.0-rc.1 --channel rc
//   node tools/publish-ros.mjs --dir release --version v1.0-rc.4 --dry-run   # 只生成清单,不上传
//
// 可选参数:
//   --commit <sha>        构建提交;缺省取 GITHUB_SHA
//   --date  YYYY-MM-DD    清单日期;缺省取当天(UTC)
//   --notes-url <url>     发行说明地址;缺省由 GITHUB_REPOSITORY + 发布 tag 推导
//   --tag <tag>           清单里记录的发布 tag;stable/rc 缺省=版本号,dev 缺省=dev
//   --manifest-out <path> 本地清单输出路径;文件名必须是本通道清单名(latest*.json)
//
// 环境变量(真上传时必需):
//   ROS_ENDPOINT      S3 端点,默认 https://cn-sy1.rains3.com
//   ROS_BUCKET        存储桶名
//   ROS_ACCESS_KEY    雨云对象存储 AccessKey
//   ROS_SECRET_KEY    雨云对象存储 SecretKey
//   ROS_PUBLIC_BASE   公开访问前缀,如 https://download.xt.markjy.com 或 https://<bucket>.cn-sy1.rains3.com
//   ROS_STYLE         path(默认, https://endpoint/bucket/key) 或 virtual(https://bucket.endpoint/key)
//   GITHUB_SHA / GITHUB_REPOSITORY  在 GitHub Actions 里自动提供,用于推导 commit / notes_url
//
// 清单结构(见 docs/发布与升级源.md 与 release/RELEASE_README.md):
//   {
//     "channel": "stable" | "dev" | "rc",
//     "version": "v1.0-rc.4-20261119.1",
//     "commit": "<完整 sha>",
//     "date": "2026-11-19",
//     "notes_url": "https://github.com/<owner>/<repo>/releases/tag/<tag>",
//     "tag": "<发布 tag>",
//     "published_at": "2026-11-19T00:00:00.000Z",   // 兼容旧消费方
//     "assets":    { "<平台>": { "url", "sha256", "size" } },
//     "platforms": { ...与 assets 相同... },          // 兼容旧版 xtc 升级 / 文档站
//     "manifests": { "<平台>": { "url", "sha256", "size" } }
//   }

import { createHash, createHmac } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const args = process.argv.slice(2)
const argVal = (name, def = '') => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def
}

const CHANNEL = (argVal('--channel', 'stable') || 'stable').toLowerCase()
// 通道 → 清单文件名(一一映射;升级器按文件名区分通道)
const MANIFEST_BY_CHANNEL = {
  stable: 'latest.json',
  dev: 'latest-dev.json',
  rc: 'latest-rc.json',
}
if (!Object.prototype.hasOwnProperty.call(MANIFEST_BY_CHANNEL, CHANNEL)) {
  console.error(`错误: --channel 只能是 stable / dev / rc 之一(当前: ${CHANNEL})`)
  process.exit(1)
}
// dev 永远不能写 latest.json,stable/rc 也不能互相覆盖 —— 清单文件名由通道强绑定
const MANIFEST_NAME = MANIFEST_BY_CHANNEL[CHANNEL]

const DIR = argVal('--dir', 'release')
const VERSION = argVal('--version', process.env.GITHUB_REF_NAME || '')
const DRY = args.includes('--dry-run')
const TAG = argVal('--tag', CHANNEL === 'dev' ? 'dev' : VERSION)
const COMMIT = argVal('--commit', process.env.GITHUB_SHA || '')
const DATE = argVal('--date', new Date().toISOString().slice(0, 10))
const NOTES_URL = argVal(
  '--notes-url',
  process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${TAG}` : '',
)
const MANIFEST_OUT = argVal('--manifest-out', MANIFEST_NAME)
const OUT_BASENAME = basename(MANIFEST_OUT).toLowerCase()

if (!VERSION) {
  console.error('错误: 缺少 --version(或 GITHUB_REF_NAME)')
  process.exit(1)
}
if (OUT_BASENAME !== MANIFEST_NAME) {
  // 双保险:通道与清单文件名必须一一对应,dev/rc 不可覆盖 stable 的 latest.json
  console.error(`错误: --channel ${CHANNEL} 的清单名必须是 ${MANIFEST_NAME},不允许写出 ${OUT_BASENAME}`)
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`错误: --date 必须是 YYYY-MM-DD(当前: ${DATE})`)
  process.exit(1)
}
if (!COMMIT) {
  console.warn('警告: 未提供 --commit 且无 GITHUB_SHA,清单里 commit 将为空')
}

const ENDPOINT = (process.env.ROS_ENDPOINT || 'https://cn-sy1.rains3.com').replace(/\/+$/, '')
const BUCKET = process.env.ROS_BUCKET || ''
const AK = process.env.ROS_ACCESS_KEY || ''
const SK = process.env.ROS_SECRET_KEY || ''
const PUBLIC_BASE = (process.env.ROS_PUBLIC_BASE || '').replace(/\/+$/, '')
const STYLE = (process.env.ROS_STYLE || 'path').toLowerCase()

const SLUGS = ['windows_amd64', 'windows_arm64', 'linux_x86_64', 'linux_arm64', 'darwin_arm64']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(DIR)
const tarballs = files.filter((f) => /^xuantie_.*_(windows_amd64|windows_arm64|linux_x86_64|linux_arm64|darwin_arm64)\.tar\.gz$/.test(basename(f)))
if (!tarballs.length) {
  console.error(`错误: ${DIR} 下没有找到 xuantie_*_<平台>.tar.gz`)
  process.exit(1)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

function uriEncodePath(key) {
  return key.split('/').map(enc).join('/')
}

function signS3(method, key, body) {
  const payloadHash = sha256(body)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const service = 's3'

  const endpointHost = ENDPOINT.replace(/^https?:\/\//, '')
  const region = endpointHost.split('.')[0] || 'cn-sy1'
  const host = STYLE === 'virtual' ? `${BUCKET}.${endpointHost}` : endpointHost
  const canonicalUri = STYLE === 'virtual' ? '/' + uriEncodePath(key) : '/' + uriEncodePath(BUCKET + '/' + key)

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`

  const hmac = (k, d) => createHmac('sha256', k).update(d).digest()
  const kDate = hmac('AWS4' + SK, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    url: `${ENDPOINT}${canonicalUri}`,
    headers: {
      Host: host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

async function put(key, body, contentType) {
  if (DRY) {
    console.log(`  [dry-run] PUT ${key} (${body.length} 字节)`)
    return
  }
  const { url, headers } = signS3('PUT', key, body)
  const res = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': contentType, 'Content-Length': String(body.length) }, body })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PUT ${key} 失败: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  console.log(`  已上传 ${key}`)
}

console.log(`通道: ${CHANNEL}  版本: ${VERSION}  发布 tag: ${TAG}  清单: ${MANIFEST_NAME}`)

const assets = {}
const manifests = {}
const prefix = `releases/${VERSION}`

for (const f of tarballs) {
  const name = basename(f)
  const slug = SLUGS.find((s) => name.includes('_' + s + '.tar.gz'))
  if (!slug) continue
  if (assets[slug]) {
    console.error(`错误: 平台 ${slug} 出现多个 tar.gz(${name}),发布包命名有歧义`)
    process.exit(1)
  }
  const body = readFileSync(f)
  const key = `${prefix}/${name}`
  const url = PUBLIC_BASE ? `${PUBLIC_BASE}/${key}` : ''
  assets[slug] = { url, sha256: sha256(body), size: body.length }
  console.log(`平台 ${slug}: ${name} (${(body.length / 1048576).toFixed(1)} MB)`)
  await put(key, body, 'application/gzip')
}

// MANIFEST 一并上传(便于第三方核验),并把指纹记进清单
for (const f of files.filter((x) => /^MANIFEST_.*\.txt$/.test(basename(x)))) {
  const name = basename(f)
  const slug = SLUGS.find((s) => name === `MANIFEST_${s}.txt`)
  if (!slug) continue
  const body = readFileSync(f)
  const key = `${prefix}/${name}`
  manifests[slug] = { url: PUBLIC_BASE ? `${PUBLIC_BASE}/${key}` : '', sha256: sha256(body), size: body.length }
  await put(key, body, 'text/plain; charset=utf-8')
}

const manifest = {
  channel: CHANNEL,
  version: VERSION,
  commit: COMMIT,
  date: DATE,
  notes_url: NOTES_URL,
  tag: TAG,
  published_at: new Date().toISOString(),
  assets,
  // 兼容旧版 xtc 升级与文档站:platforms 与 assets 同形
  platforms: assets,
  manifests,
}
const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')

mkdirSync(dirname(MANIFEST_OUT) || '.', { recursive: true })
writeFileSync(MANIFEST_OUT, manifestBody)
await put(MANIFEST_NAME, manifestBody, 'application/json; charset=utf-8')

console.log('')
console.log(`${MANIFEST_NAME}:`)
console.log(manifestBody.toString('utf8'))
if (DRY) console.log(`(dry-run: 未上传;清单已写到 ${MANIFEST_OUT})`)
else if (!PUBLIC_BASE || !manifests[Object.keys(manifests)[0]] || !assets[Object.keys(assets)[0]]?.url) {
  console.warn('注意: 未设置 ROS_PUBLIC_BASE,清单里的 url 为空,升级器无法下载')
  process.exit(2)
}
