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
  if (!enabled) return
  const entry: AiLogEntry = {
    ts: Date.now(),
    level,
    source,
    text: truncatePayload(text),
    ...(data !== undefined ? { data } : {}),
  }
  const json = JSON.stringify(entry)
  if (sink) {
    sink(json)
    return
  }
  // 默认 sink:Tauri 命令(动态引入避免 Node/测试环境加载 @tauri-apps/api)
  void import('@tauri-apps/api/core')
    .then((m) => m.invoke('ai_log_push', { entry: json }))
    .catch(() => undefined)
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
