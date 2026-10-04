/**
 * OpenAI 兼容 LlmAdapter:把 DSH 的 GenerateOptions/StreamChunk 协议
 * 翻译到 OpenAI chat.completions SSE 线上格式(社区 Agent 透传端点原样转发上游流,
 * 自定义通道直连用户自配 OpenAI 兼容提供商,两者线格式相同)。
 * 字段形状以 vendor/dsh/packages/dsh-llm/src/types.ts 与 message.ts 为准。
 * 传输经 SseTransport 注入,本文件不依赖 Tauri 桥,可在 Node 下冒烟。
 */
import { LlmAdapter, ToolCallId } from '@dsh-core'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  RequestMessage,
  StreamChunk,
} from '@dsh-core'
import type { SseTransport } from './transport'
import { aiLog, truncatePayload } from '../log-bus'

/** 本轮待发附件(面板经 runtime 注入 adapter):Agent 模式下 DSH 的 send 只收文本、
 *  附件服务未 vendor——图片/视频由 adapter 在组装 OpenAI 请求时直接注入最后一条 user 消息
 *  (与简单对话同一多模态格式;仅作用于本轮,不落 DSH 会话历史)。 */
export interface TurnAttachment {
  kind: 'image' | 'video'
  mime: string
  /** data URL(base64) */
  dataUrl: string
  name: string
}

/** 通道配置:完整端点 + 凭据,由 officialChannel/customChannel 构造(逻辑参照 aichat.ts)。 */
export interface OpenAiChannelConfig {
  /** 完整 chat completions URL */
  url: string
  /** Cookie 头(官方通道:xt_session=...) */
  cookie?: string
  /** Authorization 头(自定义通道:Bearer ...) */
  auth?: string
}

/** 官方通道 = 社区 baseUrl + /api/ai/agent/chat + xt_session cookie(model 字段被服务端强制覆盖)。 */
export function officialChannel(baseUrl: string, sessionCookie: string): OpenAiChannelConfig {
  return {
    url: baseUrl.replace(/\/+$/, '') + '/api/ai/agent/chat',
    cookie: `xt_session=${sessionCookie}`,
  }
}

/** 自定义通道 = 用户自配 OpenAI 兼容提供商 baseUrl + /chat/completions + Bearer key。 */
export function customChannel(baseUrl: string, apiKey: string): OpenAiChannelConfig {
  return {
    url: baseUrl.replace(/\/+$/, '') + '/chat/completions',
    ...(apiKey ? { auth: `Bearer ${apiKey}` } : {}),
  }
}

// ---- 请求翻译:DSH 消息 → OpenAI 消息 ----

type OpenAiMessage = Record<string, unknown>

/**
 * 内容块拼接为纯文本。image/file 等本通道无法表达的块直接抛错:
 * 静默丢弃会让模型在不知情下丢上下文,比报错更糟(AGENTS.md:宁可报错不静默跳过)。
 */
function blocksToText(blocks: readonly ContentBlock[], owner: string): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'reasoning') {
      // 推理内容不回灌(DeepSeek 官方约定:多轮对话不携带 reasoning_content)
      continue
    } else {
      throw new Error(`openai-adapter: ${owner} 含无法翻译的 ${block.type} 内容块`)
    }
  }
  return text
}

function translateMessage(message: RequestMessage): OpenAiMessage | undefined {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: blocksToText(message.content, 'system 消息') }
    case 'developer':
      // tool-addition/tool-removal 不落线:本通道每次请求都声明完整工具表
      return undefined
    case 'user':
      return { role: 'user', content: blocksToText(message.content, 'user 消息') }
    case 'assistant': {
      const toolCalls = message.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call',
      )
      const text = blocksToText(
        message.content.filter((b) => b.type !== 'tool-call'),
        'assistant 消息',
      )
      return {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0
          ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
          : {}),
      }
    }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: blocksToText(message.content, 'tool 结果'),
      }
  }
}

function translateRequest(options: GenerateOptions, attachments: readonly TurnAttachment[] = []): Record<string, unknown> {
  const messages: OpenAiMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  // 最后一条 user 消息(附件注入目标)
  let lastUser = -1
  for (let i = 0; i < options.messages.length; i++) {
    if (options.messages[i]?.role === 'user') lastUser = i
  }
  for (let i = 0; i < options.messages.length; i++) {
    const m = options.messages[i] as (typeof options.messages)[number]
    if (i === lastUser && attachments.length > 0) {
      // 多模态数组格式(与简单对话一致):文本 + image_url/video_url(data URL 直发)
      const text = blocksToText(m.content, 'user 消息')
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text },
          ...attachments.map((a) =>
            a.kind === 'image'
              ? { type: 'image_url', image_url: { url: a.dataUrl } }
              : { type: 'video_url', video_url: { url: a.dataUrl } },
          ),
        ],
      })
      continue
    }
    const translated = translateMessage(m)
    if (translated) messages.push(translated)
  }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools && options.tools.length > 0
      ? {
        tools: options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }
      : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
  }
}

// ---- 响应翻译:OpenAI SSE → DSH StreamChunk ----

/** OpenAI finish_reason → DSH FinishReason;未知值映射为 error(不静默吞掉)。 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { code: `PROVIDER_FINISH_${reason.toUpperCase()}`, message: `provider finish_reason: ${reason}` },
      }
  }
}

interface OpenAiDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

interface OpenAiChunk {
  choices?: { index: number; delta?: OpenAiDelta; finish_reason?: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    /** DeepSeek:命中/未命中缓存的输入 token */
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    /** OpenAI:缓存命中读取 token */
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

type UsageChunk = Extract<StreamChunk, { type: 'usage' }>['usage']

/** OpenAI usage → DSH usage 帧(流式 chunk 与非流式响应共用;缓存字段解析)。 */
function mapUsage(u: NonNullable<OpenAiChunk['usage']>): UsageChunk {
  // 缓存读取:DeepSeek prompt_cache_hit_tokens 优先,回落 OpenAI details.cached_tokens
  const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    ...(typeof u.total_tokens === 'number' ? { totalTokens: u.total_tokens } : {}),
    ...(typeof u.completion_tokens_details?.reasoning_tokens === 'number'
      ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
    ...(typeof u.prompt_cache_miss_tokens === 'number' ? { cacheMissTokens: u.prompt_cache_miss_tokens } : {}),
  }
}

/** 非流式响应形状(截断恢复用;字段名以 OpenAI 兼容线格式为准)。 */
interface OpenAiFullResponse {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: OpenAiChunk['usage']
}

interface ToolCallAssembly {
  blockIndex: number
  id: string
  name: string
  arguments: string
}

export class OpenAiCompatAdapter extends LlmAdapter {
  constructor(
    private readonly channel: OpenAiChannelConfig,
    private readonly transport: SseTransport,
    /** 本轮待发附件(面板提供;turn 内所有请求都带,含截断恢复的重发) */
    private readonly getAttachments?: () => readonly TurnAttachment[],
  ) {
    super()
  }

  /**
   * 能力协商:OpenAI 兼容通道的模型能力由上游决定,本地无从枚举。
   * 官方通道的模型名(如「玄铁大模型」)是服务端路由占位符,真实模型由社区后台配置。
   * 因此声明全量 reasoning 档位(含 xhigh/max,ChatGPT/Claude 系支持)做透传——
   * 上游不认该档位时由上游报错,不让本地协商误杀(默认实现无 reasoning 元数据,
   * 会拒绝一切显式 effort)。
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const efforts = (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((id) => ({
      id: id as ReasoningEffortId,
      name: id,
    }))
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const attachments = this.getAttachments?.() ?? []
    const body = translateRequest(options, attachments)
    if (attachments.length > 0) {
      aiLog('info', 'adapter', `本轮附件注入: ${attachments.map((a) => `${a.kind}:${a.name}`).join('、')}(最后一条 user 消息)`)
    }
    aiLog('debug', 'adapter', `请求 ${this.channel.url} model=${options.model}`, truncatePayload(JSON.stringify(body)))

    // 块装配状态:text/reasoning 共享一个"当前打开块",tool-call 按 OpenAI tc.index 各占一块
    let openIndex = -1
    let openKind: 'text' | 'reasoning' = 'text'
    let openText = ''
    let nextIndex = 0
    const toolCalls = new Map<number, ToolCallAssembly>()
    let finishReason: FinishReason | undefined
    // 截断恢复准入:已发出正文/工具调用则不许补全(会造成重复拼接),只有 reasoning 允许重来
    let emittedText = false
    let emittedToolCall = false
    let nChunks = 0 // 诊断:收到的有效 chunk 数(截断日志用)

    const closeTextBlock = (): StreamChunk | undefined => {
      if (openIndex < 0) return undefined
      const chunk: StreamChunk = {
        type: 'block-end',
        index: openIndex,
        block: { type: openKind, text: openText },
      }
      openIndex = -1
      openText = ''
      return chunk
    }

    try {
      for await (const payload of this.transport.stream({
        url: this.channel.url,
        body,
        cookie: this.channel.cookie,
        auth: this.channel.auth,
        signal: options.signal,
      })) {
        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(payload) as OpenAiChunk
        } catch (parseErr) {
          aiLog('warn', 'adapter', `SSE 载荷非 JSON,跳过: ${String(parseErr)}`, truncatePayload(payload, 512, 128))
          continue // 非 JSON 载荷(注释行/心跳)跳过
        }
        nChunks++
        // 注:逐块 chunk 摘要曾以每秒上千条灌满诊断缓冲(实测),已删除;
        // 需要协议级排查时看 transport 的首块抽样(含原始载荷)
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta) {
          const reasoning =
            (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
            (typeof delta.reasoning === 'string' && delta.reasoning) ||
            ''
          if (reasoning) {
            if (openIndex < 0 || openKind !== 'reasoning') {
              const end = closeTextBlock()
              if (end) yield end
              openIndex = nextIndex++
              openKind = 'reasoning'
              yield { type: 'block-start', index: openIndex, blockType: 'reasoning' }
            }
            openText += reasoning
            yield { type: 'reasoning-delta', index: openIndex, text: reasoning }
          }
          const content = typeof delta.content === 'string' ? delta.content : ''
          if (content) {
            if (openIndex < 0 || openKind !== 'text') {
              const end = closeTextBlock()
              if (end) yield end
              openIndex = nextIndex++
              openKind = 'text'
              yield { type: 'block-start', index: openIndex, blockType: 'text' }
            }
            openText += content
            emittedText = true
            yield { type: 'text-delta', index: openIndex, text: content }
          }
          for (const tc of delta.tool_calls ?? []) {
            const end = closeTextBlock()
            if (end) yield end
            const slot = typeof tc.index === 'number' ? tc.index : 0
            let state = toolCalls.get(slot)
            if (!state) {
              state = { blockIndex: nextIndex++, id: tc.id ?? '', name: '', arguments: '' }
              toolCalls.set(slot, state)
              yield { type: 'block-start', index: state.blockIndex, blockType: 'tool-call' }
            }
            if (tc.id) state.id = tc.id
            const nameDelta = tc.function?.name ?? ''
            const argsDelta = tc.function?.arguments ?? ''
            if (nameDelta) state.name += nameDelta
            if (argsDelta) state.arguments += argsDelta
            if (nameDelta || argsDelta) {
              emittedToolCall = true
              yield {
                type: 'tool-call-delta',
                index: state.blockIndex,
                id: ToolCallId(state.id),
                ...(nameDelta ? { name: state.name } : {}),
                argumentsDelta: argsDelta,
              }
            }
          }
        }
        if (chunk.usage) {
          yield { type: 'usage', usage: mapUsage(chunk.usage) }
        }
        const fr = choice?.finish_reason
        if (fr) finishReason = mapFinishReason(fr)
      }

      // 流正常结束:关闭所有打开的块,再发终结帧
      const end = closeTextBlock()
      if (end) yield end
      for (const state of [...toolCalls.values()].sort((a, b) => a.blockIndex - b.blockIndex)) {
        yield {
          type: 'block-end',
          index: state.blockIndex,
          block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.arguments },
        }
      }
      // 流被截断(无 finish_reason)且尚未发出正文/工具调用 → 降级非流式补全:
      // 同请求 stream:false 重取完整结果,补发为等价流事件,上层无感继续(仅多付一次生成费用)。
      // 已发正文/工具调用时不做补全(重生成内容不可拼接),按截断错误上抛,由 UI 提供「继续」。
      if (!finishReason && !emittedText && !emittedToolCall && options.signal?.aborted !== true) {
        const recovered = await this.recoverNonStream(body)
        if (recovered) {
          if (recovered.content) {
            const idx = nextIndex++
            yield { type: 'block-start', index: idx, blockType: 'text' }
            yield { type: 'text-delta', index: idx, text: recovered.content }
            yield { type: 'block-end', index: idx, block: { type: 'text', text: recovered.content } }
          }
          for (const tc of recovered.toolCalls) {
            const idx = nextIndex++
            yield { type: 'block-start', index: idx, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: idx, id: ToolCallId(tc.id), name: tc.name, argumentsDelta: tc.arguments }
            yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: ToolCallId(tc.id), name: tc.name, arguments: tc.arguments } }
          }
          if (recovered.usage) yield { type: 'usage', usage: recovered.usage }
          finishReason = recovered.finishReason
          aiLog('info', 'adapter', `STREAM_TRUNCATED → 非流式补全成功(${recovered.content.length} 字符正文/${recovered.toolCalls.length} 个工具调用,finish=${finishReason.kind})`)
        } else {
          aiLog('warn', 'adapter', 'STREAM_TRUNCATED → 非流式补全未成功,按错误上抛')
        }
      }
      if (!finishReason) {
        aiLog(
          'warn',
          'adapter',
          `SSE 流结束但未收到 finish_reason(STREAM_TRUNCATED):已收 ${nChunks} 块,正文${emittedText ? '有' : '无'},工具调用${emittedToolCall ? '有' : '无'}`,
          undefined,
        )
      }
      aiLog('info', 'adapter', `finish: ${finishReason?.kind ?? 'error(STREAM_TRUNCATED)'}`)
      yield {
        type: 'finish',
        reason: finishReason ?? {
          // OpenAI 协议保证流尾必有 finish_reason;缺失 = 流被截断,按错误处理而非伪装 stop
          kind: 'error',
          failure: { code: 'STREAM_TRUNCATED', message: 'SSE 流结束但未收到 finish_reason' },
        },
      }
    } catch (error) {
      // 传输错误/中止 → 终结帧(DSH 约定 adapter 可抛,LlmRuntime 会归一化;
      // 这里显式发帧以保留 provider 侧错误语义)
      const aborted = options.signal?.aborted === true
      aiLog(aborted ? 'info' : 'error', 'adapter', aborted ? '流被用户中止' : `传输异常: ${error instanceof Error ? error.message : String(error)}`)
      yield {
        type: 'finish',
        reason: {
          kind: aborted ? 'aborted' : 'error',
          failure: {
            code: aborted ? 'ABORTED' : 'TRANSPORT_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      }
    }
  }

  /**
   * 截断恢复:同一请求改 stream:false 重取完整结果(官方通道服务端支持非流式透传)。
   * 传输/协议失败或响应为空 → 返回 undefined,调用方按原截断报错。
   */
  private async recoverNonStream(streamBody: Record<string, unknown>): Promise<
    | {
      content: string
      toolCalls: { id: string; name: string; arguments: string }[]
      usage?: UsageChunk
      finishReason: FinishReason
    }
    | undefined
  > {
    if (!this.transport.json) return undefined
    const body: Record<string, unknown> = { ...streamBody, stream: false }
    delete body.stream_options
    let raw: unknown
    try {
      raw = await this.transport.json({
        url: this.channel.url,
        body,
        cookie: this.channel.cookie,
        auth: this.channel.auth,
      })
    } catch (error) {
      aiLog('warn', 'adapter', `截断恢复:非流式请求失败: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const parsed = raw as OpenAiFullResponse
    const choice = parsed.choices?.[0]
    const message = choice?.message
    if (!message) return undefined
    const content = typeof message.content === 'string' ? message.content : ''
    const toolCalls = (message.tool_calls ?? []).map((t) => ({
      id: t.id ?? '',
      name: t.function?.name ?? '',
      arguments: t.function?.arguments ?? '',
    }))
    if (content === '' && toolCalls.length === 0) return undefined
    return {
      content,
      toolCalls,
      ...(parsed.usage ? { usage: mapUsage(parsed.usage) } : {}),
      // 非流式兜底:完成帧缺失时按 stop(完整 message 已拿到,不再当截断)
      finishReason: mapFinishReason(choice?.finish_reason ?? 'stop'),
    }
  }
}
