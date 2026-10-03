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

function translateRequest(options: GenerateOptions): Record<string, unknown> {
  const messages: OpenAiMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const m of options.messages) {
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
    const body = translateRequest(options)
    aiLog('debug', 'adapter', `请求 ${this.channel.url} model=${options.model}`, truncatePayload(JSON.stringify(body)))

    // 块装配状态:text/reasoning 共享一个"当前打开块",tool-call 按 OpenAI tc.index 各占一块
    let openIndex = -1
    let openKind: 'text' | 'reasoning' = 'text'
    let openText = ''
    let nextIndex = 0
    const toolCalls = new Map<number, ToolCallAssembly>()
    let finishReason: FinishReason | undefined

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
        // chunk 类型摘要(debug:字段级,不含正文)
        aiLog('debug', 'adapter', `chunk: keys=[${Object.keys(chunk).join(',')}] delta_keys=[${Object.keys(chunk.choices?.[0]?.delta ?? {}).join(',')}]${chunk.choices?.[0]?.finish_reason ? ` finish=${chunk.choices[0].finish_reason}` : ''}`)
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
          const u = chunk.usage
          // 缓存读取:DeepSeek prompt_cache_hit_tokens 优先,回落 OpenAI details.cached_tokens
          const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens
          yield {
            type: 'usage',
            usage: {
              inputTokens: u.prompt_tokens ?? 0,
              outputTokens: u.completion_tokens ?? 0,
              ...(typeof u.total_tokens === 'number' ? { totalTokens: u.total_tokens } : {}),
              ...(typeof u.completion_tokens_details?.reasoning_tokens === 'number'
                ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens }
                : {}),
              ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
              ...(typeof u.prompt_cache_miss_tokens === 'number'
                ? { cacheMissTokens: u.prompt_cache_miss_tokens }
                : {}),
            },
          }
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
      if (!finishReason) {
        aiLog('warn', 'adapter', 'SSE 流结束但未收到 finish_reason(STREAM_TRUNCATED)', undefined)
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
}
