#!/usr/bin/env node
// tools/publish-ros.mjs —— 把发行包上传到雨云 ROS(S3 兼容),并生成 latest.json
//
// 用法:
//   node tools/publish-ros.mjs --dir release --version v1.0-rc.4          # 真上传
//   node tools/publish-ros.mjs --dir release --version v1.0-rc.4 --dry-run # 只打印计划并生成本地 latest.json
//
// 环境变量(真上传时必需):
//   ROS_ENDPOINT      S3 端点,默认 https://cn-sy1.rains3.com
//   ROS_BUCKET        存储桶名
//   ROS_ACCESS_KEY    雨云对象存储 AccessKey
//   ROS_SECRET_KEY    雨云对象存储 SecretKey
//   ROS_PUBLIC_BASE   公开访问前缀,如 https://download.xt.markjy.com 或 https://<bucket>.cn-sy1.rains3.com
//   ROS_STYLE         path(默认, https://endpoint/bucket/key) 或 virtual(https://bucket.endpoint/key)
//
// latest.json 结构(供 xtc 升级 --国内 使用):
//   { "version": "v1.0-rc.4",
//     "published_at": "2026-...",
//     "platforms": { "windows_amd64": { "url": "...", "sha256": "...", "size": 123 } } }

import { createHash, createHmac } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, relative } from 'node:path'

const args = process.argv.slice(2)
const argVal = (name, def = '') => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def
}

const DIR = argVal('--dir', 'release')
const VERSION = argVal('--version', process.env.GITHUB_REF_NAME || '')
const DRY = args.includes('--dry-run')
const ENDPOINT = (process.env.ROS_ENDPOINT || 'https://cn-sy1.rains3.com').replace(/\/+$/, '')
const BUCKET = process.env.ROS_BUCKET || ''
const AK = process.env.ROS_ACCESS_KEY || ''
const SK = process.env.ROS_SECRET_KEY || ''
const PUBLIC_BASE = (process.env.ROS_PUBLIC_BASE || '').replace(/\/+$/, '')
const STYLE = (process.env.ROS_STYLE || 'path').toLowerCase()

if (!VERSION) {
  console.error('错误: 缺少 --version(或 GITHUB_REF_NAME)')
  process.exit(1)
}

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

const platforms = {}
const prefix = `releases/${VERSION}`

for (const f of tarballs) {
  const name = basename(f)
  const slug = SLUGS.find((s) => name.includes('_' + s + '.tar.gz'))
  if (!slug) continue
  const body = readFileSync(f)
  const key = `${prefix}/${name}`
  const url = PUBLIC_BASE ? `${PUBLIC_BASE}/${key}` : ''
  platforms[slug] = { url, sha256: sha256(body), size: body.length }
  console.log(`平台 ${slug}: ${name} (${(body.length / 1048576).toFixed(1)} MB)`)
  await put(key, body, 'application/gzip')
}

// MANIFEST 一并上传(便于第三方核验)
for (const f of files.filter((x) => /^MANIFEST_.*\.txt$/.test(basename(x)))) {
  const name = basename(f)
  await put(`${prefix}/${name}`, readFileSync(f), 'text/plain; charset=utf-8')
}

const latest = {
  version: VERSION,
  published_at: new Date().toISOString(),
  platforms,
}
const latestBody = Buffer.from(JSON.stringify(latest, null, 2), 'utf8')
writeFileSync('latest.json', latestBody)
await put('latest.json', latestBody, 'application/json; charset=utf-8')

console.log('')
console.log('latest.json:')
console.log(latestBody.toString('utf8'))
if (DRY) console.log('(dry-run: 未上传;latest.json 已写到当前目录)')
else if (!PUBLIC_BASE || !platforms[Object.keys(platforms)[0]]?.url) {
  console.warn('注意: 未设置 ROS_PUBLIC_BASE,latest.json 里的 url 为空,xtc 升级无法下载')
  process.exit(2)
}
