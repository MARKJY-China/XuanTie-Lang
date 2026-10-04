/**
 * WebView 侧 SseTransport 实现:桥接 Rust http_stream(format='sse-raw')。
 * Rust 侧把每个 SSE data 载荷原样包成 {type:"sse",data} 经 ai-stream-{id} 事件推回,
 * status/error/aborted/done 事件维持原语义([DONE] 已被 Rust 转成 done)。
 * 仅在 Tauri WebView 内可用;Node 冒烟注入自己的 stub,不经过本文件。
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { httpJson, httpStream, httpStreamAbort } from '../../backend'
import { aiLog, truncatePayload } from '../log-bus'
import type { SseRequest, SseTransport } from './transport'

type QueueItem =
  | { kind: 'sse'; data: string }
  | { kind: 'error'; message: string }
  | { kind: 'end' }

export class TauriSseTransport implements SseTransport {
  /** 非流式 POST(截断恢复):与流式同一条 Rust HTTP 通道与鉴权;非 2xx 抛错。 */
  async json(request: SseRequest): Promise<unknown> {
    const r = await httpJson('POST', request.url, request.body, request.cookie, request.auth, 300)
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 300)}`)
    }
    return JSON.parse(r.body) as unknown
  }

  async *stream(request: SseRequest): AsyncIterable<string> {
    const id = `dsh-${crypto.randomUUID()}`
    const queue: QueueItem[] = []
    let notify: (() => void) | undefined
    // 静默监控:30s 无任何数据块即告警一次——"模型在思考"与"流已卡死/将断"从此可辨
    let nSse = 0
    let lastDataAt = Date.now()
    let silentReported = false
    const silentTimer = window.setInterval(() => {
      const gap = Date.now() - lastDataAt
      if (gap >= 30000 && !silentReported) {
        silentReported = true
        aiLog(
          'warn',
          'transport',
          `数据流已静默 ${Math.round(gap / 1000)}s(最后数据块在 ${new Date(lastDataAt).toLocaleTimeString('zh-CN', { hour12: false })},已收 ${nSse} 块):上游可能卡住或即将断开`,
        )
      }
    }, 5000)
    const push = (item: QueueItem): void => {
      queue.push(item)
      const n = notify
      notify = undefined
      n?.()
    }

    // 终结去重 + 事件兜底:end 只入队一次;invoke settle(Rust 函数返回)后延迟 1s 补 end,
    // 防止 done 事件在 IPC 链路丢失导致生成器永久悬置(会让 agent.whenIdle 永不 settle、
    // 面板 busy 卡死)。延迟是给已发出的尾部事件留出到达窗口,避免误截断。
    let ended = false
    const endOnce = (): void => {
      if (ended) return
      ended = true
      push({ kind: 'end' })
    }

    const unlisten: UnlistenFn = await listen<string>(`ai-stream-${id}`, (e) => {
      let ev: { type?: string; data?: unknown; message?: unknown }
      try {
        ev = JSON.parse(e.payload) as typeof ev
      } catch {
        return
      }
      if (ev.type === 'sse' && typeof ev.data === 'string') {
        // 降噪:逐块 debug 曾以每秒上千条速率淹没诊断缓冲(实测),改为首块 + 每 100 块抽样
        nSse++
        if (nSse === 1 || nSse % 100 === 0) {
          aiLog('debug', 'transport', `sse data 第 ${nSse} 块(${ev.data.length}B)`, nSse === 1 ? truncatePayload(ev.data) : undefined)
        }
        lastDataAt = Date.now()
        silentReported = false
        push({ kind: 'sse', data: ev.data })
      } else if (ev.type === 'status') {
        aiLog('info', 'transport', `HTTP status ${String((ev as { status?: unknown }).status ?? '?')}`)
      } else if (ev.type === 'error') {
        aiLog('warn', 'transport', `传输错误: ${typeof ev.message === 'string' ? ev.message : '未知'}`)
        push({ kind: 'error', message: typeof ev.message === 'string' ? ev.message : '未知传输错误' })
      } else if (ev.type === 'warn') {
        // Rust 读流端的诊断(如"上游 EOF 未收到 [DONE]"):断流根因的唯一实据来源
        aiLog('warn', 'transport', `流诊断: ${typeof ev.message === 'string' ? ev.message : '未知'}`)
      } else if (ev.type === 'stat' && ev.data && typeof ev.data === 'object') {
        const d = ev.data as { chunks?: number; bytes?: number; ms?: number; end?: string; silentMs?: number }
        aiLog(
          d.end === 'done' ? 'info' : 'warn',
          'transport',
          `流统计: 结束=${d.end ?? '?'} 块=${d.chunks ?? '?'} 字节=${d.bytes ?? '?'} 用时=${d.ms ?? '?'}ms 末次数据距今=${d.silentMs ?? '?'}ms`,
        )
      } else if (ev.type === 'done' || ev.type === 'aborted') {
        aiLog('info', 'transport', ev.type === 'done' ? '流结束(done)' : '流中止(aborted)')
        endOnce()
      }
      // status 事件忽略:非 200 时 Rust 侧会跟发 error + done
    })

    const onAbort = (): void => {
      void httpStreamAbort(id)
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // invoke 的 Promise 在 Rust 侧整个流结束时才 settle;启动失败(reject)也进队列
      void httpStream(id, 'POST', request.url, request.body, request.cookie, request.auth, 'sse-raw')
        .then(() => setTimeout(endOnce, 1000))
        .catch((err: unknown) => {
          aiLog('warn', 'transport', `invoke 失败: ${String(err)}`)
          push({ kind: 'error', message: String(err) })
        })

      for (;;) {
        while (queue.length > 0) {
          const item = queue.shift() as QueueItem
          if (item.kind === 'sse') {
            yield item.data
          } else if (item.kind === 'error') {
            throw new Error(item.message)
          } else {
            return
          }
        }
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    } finally {
      window.clearInterval(silentTimer)
      request.signal?.removeEventListener('abort', onAbort)
      unlisten()
      // 消费者提前 abandon(中止/异常)时确保 Rust 侧流被掐掉;已结束的流上调用是无害 no-op
      void httpStreamAbort(id)
    }
  }
}
