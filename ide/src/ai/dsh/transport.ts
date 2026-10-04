/**
 * SSE 传输抽象:OpenAI 兼容适配器不直接依赖 Tauri 桥(backend.ts),
 * WebView 实现见 transport-tauri.ts;Node 冒烟/测试注入 stub 实现。
 */

export interface SseRequest {
  /** 完整 chat completions 端点 */
  url: string
  /** 请求体(将被 JSON 序列化 POST) */
  body: unknown
  /** Cookie 头(官方通道:xt_session=...) */
  cookie?: string
  /** Authorization 头(自定义通道:Bearer ...) */
  auth?: string
  /** 中止信号:触发后传输层应尽快结束迭代或抛错 */
  signal?: AbortSignal
}

export interface SseTransport {
  /**
   * 产出 SSE data 载荷字符串流([DONE] 由传输层消化,不产出)。
   * 传输错误(连接失败/非 200/读流失败)以异常抛出;中止时 signal.aborted 为 true。
   */
  stream(request: SseRequest): AsyncIterable<string>

  /**
   * 非流式 JSON POST(流截断恢复用:同一请求 stream:false 重取完整结果)。
   * 可选实现:冒烟 stub 可不提供,调用方(adapter)自动回落报错路径。
   */
  json?(request: SseRequest): Promise<unknown>
}
