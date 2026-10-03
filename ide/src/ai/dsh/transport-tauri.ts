/**
 * WebView 侧 SseTransport 实现:桥接 Rust http_stream(format='sse-raw')。
 * Rust 侧把每个 SSE data 载荷原样包成 {type:"sse",data} 经 ai-stream-{id} 事件推回,
 * status/error/aborted/done 事件维持原语义([DONE] 已被 Rust 转成 done)。
 * 仅在 Tauri WebView 内可用;Node 冒烟注入自己的 stub,不经过本文件。
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { httpStream, httpStreamAbort } from '../../backend'
import { aiLog, truncatePayload } from '../log-bus'
import type { SseRequest, SseTransport } from './transport'

type QueueItem =
  | { kind: 'sse'; data: string }
  | { kind: 'error'; message: string }
  | { kind: 'end' }

export class TauriSseTransport implements SseTransport {
  async *stream(request: SseRequest): AsyncIterable<string> {
    const id = `dsh-${crypto.randomUUID()}`
    const queue: QueueItem[] = []
    let notify: (() => void) | undefined
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
        aiLog('debug', 'transport', `sse data (${ev.data.length}B)`, truncatePayload(ev.data))
        push({ kind: 'sse', data: ev.data })
      } else if (ev.type === 'status') {
        aiLog('info', 'transport', `HTTP status ${String((ev as { status?: unknown }).status ?? '?')}`)
      } else if (ev.type === 'error') {
        aiLog('warn', 'transport', `传输错误: ${typeof ev.message === 'string' ? ev.message : '未知'}`)
        push({ kind: 'error', message: typeof ev.message === 'string' ? ev.message : '未知传输错误' })
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
      request.signal?.removeEventListener('abort', onAbort)
      unlisten()
      // 消费者提前 abandon(中止/异常)时确保 Rust 侧流被掐掉;已结束的流上调用是无害 no-op
      void httpStreamAbort(id)
    }
  }
}
