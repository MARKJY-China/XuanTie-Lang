#!/usr/bin/env node
// scripts/pipe-progress.mjs —— 把 stdin 原样转发到 stdout，并在 stderr 打上传进度
//
// 为什么需要它：deploy.sh 用 `tar.gz | ssh 'tar -xz'` 流式上传，管道本身没有进度；
// 这里做一段透明转发 + 进度显示，不依赖服务器装 rsync/pv。
//
// 用法：node scripts/pipe-progress.mjs <总字节数> < 上传包 > （ssh 的 stdin）
// 进度行用 \r 覆盖写，只在 stderr 输出，不会污染 tar 数据流。

const total = Number(process.argv[2] || 0)
let sent = 0
let lastMs = 0
const t0 = Date.now()
const isTTY = process.stderr.isTTY

const fmt = (n) => (n / 1048576).toFixed(1) + ' MB'

function draw(force = false) {
  const now = Date.now()
  if (!force && now - lastMs < 120) return
  lastMs = now
  const pct = total > 0 ? Math.min(100, (sent / total) * 100) : 0
  const secs = (now - t0) / 1000
  const speed = secs > 0 ? sent / secs : 0
  const eta = speed > 0 && total > sent ? Math.round((total - sent) / speed) : 0
  const width = 24
  const filled = Math.round((pct / 100) * width)
  const bar = '█'.repeat(filled) + '·'.repeat(width - filled)
  const line = `上传 ${bar} ${pct.toFixed(1).padStart(5)}%  ${fmt(sent)} / ${fmt(total)}  ${fmt(speed)}/s  剩余 ${eta}s`
  if (isTTY) process.stderr.write('\r\u001b[2K' + line)
  else process.stderr.write(line + '\n')
}

process.stdin.on('data', (chunk) => {
  sent += chunk.length
  const ok = process.stdout.write(chunk)
  if (!ok) {
    process.stdin.pause()
    process.stdout.once('drain', () => process.stdin.resume())
  }
  draw()
})

process.stdin.on('end', () => {
  draw(true)
  if (isTTY) process.stderr.write('\n')
})

process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0) // 对端已关闭（远端提前失败），静静退出
  throw e
})
