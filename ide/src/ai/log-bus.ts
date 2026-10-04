/**
 * AI 链路日志总线:TS 侧入口(Rust 侧 ailog.rs 是存储/广播中枢)。
 * - devMode 关时直接丢弃(零 invoke 开销);开关由 settings.devMode 驱动,main.ts 装配。
 * - sink 可注入(Node 单测);默认走 Tauri invoke('ai_log_push')。
 * - installGlobalErrorHooks:window.onerror / unhandledrejection → error 级(偶发报错定位用)。
 */

export type AiLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AiLogEntry {
  /** epoch 毫秒 */
  ts: number
  level: AiLogLevel
  /** 来源模块:transport / adapter / agent-mode / aichat / global */
  source: string
  text: string
  /** 结构化载荷(控制台窗口可展开) */
  data?: unknown
}

export type AiLogSink = (entryJson: string) => void

let enabled = false
let sink: AiLogSink | undefined

/** 诊断历史:分池保留——关键(warn/error)独立保底,永不被高频 debug 挤出。
 *  (实测教训:逐块 SSE debug 日志 0.26 秒即可灌满单池 500 条,「复制诊断」只剩原始数据块,
 *  断流原因全被冲掉。关键事件与噪音必须隔离。) */
const warnPool: AiLogEntry[] = []
const dbgPool: AiLogEntry[] = []
const WARN_CAP = 200
const DBG_CAP = 300

/** 设置日志开关(同步 Rust 侧采集开关)。 */
export function setAiLogEnabled(v: boolean, invokeSetEnabled?: (v: boolean) => void): void {
  enabled = v
  if (invokeSetEnabled) invokeSetEnabled(v)
}

/** 注入 sink(测试/Node);恢复默认传 undefined。 */
export function setAiLogSink(fn: AiLogSink | undefined): void {
  sink = fn
}

/** 长文本截断:保留前 2KB + 后 512B,中间标注省略量。 */
export function truncatePayload(text: string, head = 2048, tail = 512): string {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n…[省略 ${text.length - head - tail} 字符]…\n${text.slice(text.length - tail)}`
}

export function aiLog(level: AiLogLevel, source: string, text: string, data?: unknown): void {
  // warn/error 永不静默:故障定位信息必须始终留存(实测反馈:未开 devMode 时
  // 断流等问题在控制台无任何线索,根因不可查)。debug/info 仍由开发者模式控制。
  const important = level === 'warn' || level === 'error'
  if (!enabled && !important) return
  const entry: AiLogEntry = {
    ts: Date.now(),
    level,
    source,
    text: truncatePayload(text),
    ...(data !== undefined ? { data } : {}),
  }
  if (important) {
    warnPool.push(entry)
    if (warnPool.length > WARN_CAP) warnPool.shift()
  } else {
    dbgPool.push(entry)
    if (dbgPool.length > DBG_CAP) dbgPool.shift()
  }
  const json = JSON.stringify(entry)
  if (sink) {
    sink(json)
    return
  }
  if (!enabled) return // 未开模式时仅入前端历史(供「复制诊断」导出)
  // 默认 sink:Tauri 命令(动态引入避免 Node/测试环境加载 @tauri-apps/api)
  void import('@tauri-apps/api/core')
    .then((m) => m.invoke('ai_log_push', { entry: json }))
    .catch(() => undefined)
}

/** 单条日志 → 文本行。 */
function fmtEntry(e: AiLogEntry): string {
  const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(e.ts % 1000).padStart(3, '0')
  let d = ''
  if (e.data !== undefined) {
    try {
      d = ' | ' + truncatePayload(JSON.stringify(e.data), 300, 100)
    } catch {
      d = ' | [data 无法序列化]'
    }
  }
  return '[' + t + '][' + e.level + '][' + e.source + '] ' + e.text + d
}

/** 连续 ≥5 条同源同级普通日志折叠为一行(时间跨度 + 条数),防原始数据块淹没导出。 */
function foldDbg(list: AiLogEntry[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < list.length) {
    const cur = list[i]
    let j = i + 1
    while (j < list.length && list[j].source === cur.source && list[j].level === cur.level) j++
    const n = j - i
    if (n >= 5) {
      const a = list[i]
      const b = list[j - 1]
      const ta = new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false })
      const tb = new Date(b.ts).toLocaleTimeString('zh-CN', { hour12: false })
      out.push(`[${ta}→${tb}][${a.level}][${a.source}] …共 ${n} 条同类日志(已折叠;示例: ${a.text})`)
    } else {
      for (let k = i; k < j; k++) out.push(fmtEntry(list[k]))
    }
    i = j
  }
  return out
}

/** 导出诊断文本(错误气泡「复制诊断」用):关键事件全列置顶,普通日志折叠呈现。 */
export function exportLogText(limit = 300): string {
  const sep = `── 普通日志(最近 ${limit} 条,同类已折叠) ──`
  const head = [
    '===== 玄铁铸造厂诊断信息 =====',
    '导出时间: ' + new Date().toLocaleString('zh-CN'),
    '关键事件(warn/error): ' + warnPool.length + ' 条(全列于下)',
    '普通日志(debug/info): ' + dbgPool.length + ' 条(折叠呈现)',
    '',
    '── 关键事件 ──',
  ].join('\n')
  const warnText = warnPool.map(fmtEntry).join('\n')
  const dbgTail = foldDbg(dbgPool.slice(-limit)).join('\n')
  return head + '\n' + (warnText || '(无)') + '\n' + sep + '\n' + (dbgTail || '(无)') + '\n'
}

/** 全局未捕获错误 → error 级日志(偶发报错定位)。幂等。 */
let hooksInstalled = false
export function installGlobalErrorHooks(): void {
  if (hooksInstalled || typeof window === 'undefined') return
  hooksInstalled = true
  window.addEventListener('error', (e) => {
    aiLog('error', 'global', `${e.message} @ ${e.filename}:${e.lineno}`, e.error ? String(e.error.stack ?? e.error) : undefined)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    aiLog('error', 'global', `unhandledrejection: ${r instanceof Error ? r.message : String(r)}`, r instanceof Error ? (r.stack ?? undefined) : undefined)
  })
}

/** 控制台窗口的条目过滤(纯函数,可单测):级别集合 + 文本包含 + 来源前缀。 */
export function filterEntries(
  entries: AiLogEntry[],
  opts: { levels: ReadonlySet<AiLogLevel>; text?: string; source?: string },
): AiLogEntry[] {
  const text = (opts.text ?? '').trim().toLowerCase()
  const source = (opts.source ?? '').trim().toLowerCase()
  return entries.filter((e) => {
    if (!opts.levels.has(e.level)) return false
    if (source && !e.source.toLowerCase().includes(source)) return false
    if (text) {
      const hay = `${e.text} ${e.data !== undefined ? JSON.stringify(e.data) : ''}`.toLowerCase()
      if (!hay.includes(text)) return false
    }
    return true
  })
}
