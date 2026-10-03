/**
 * `@dsh-core`(ide/vendor/dsh/dist/dsh-core.mjs)的手写类型声明。
 * 刻意收窄:只声明 ide 运行时用到的面,字段以 DSH 0.2.0-rc.2 源码
 * (dsh-llm/src/types.ts、dsh-llm/src/message.ts、dsh-agent/src/runtime-types.ts)为准。
 * vendor 源码不进 tsc(include 只有 src),这里出错以 vendor 源码为仲裁。
 */
declare module '@dsh-core' {
  // ---- 品牌类型 ----
  type Brand<B> = string & { readonly __brand: B }
  export type ToolCallId = Brand<'ToolCallId'>
  export type SessionId = Brand<'SessionId'>
  export type MessageId = Brand<'MessageId'>
  export type ReasoningEffortId = Brand<'ReasoningEffortId'>

  // ---- 内容块与消息(dsh-llm/src/types.ts, message.ts)----
  export interface TextBlock { type: 'text'; text: string }
  export interface ReasoningBlock { type: 'reasoning'; text: string }
  export interface ToolCallBlock {
    type: 'tool-call'
    id: ToolCallId
    name: string
    /** 模型产出的原始 JSON 字符串 */
    arguments: string
  }
  export interface ImageBlock { type: 'image'; attachment: unknown; offloaded?: true }
  export interface FileBlock { type: 'file'; attachment: unknown }
  export interface ToolAdditionBlock { type: 'tool-addition'; toolName: string }
  export interface ToolRemovalBlock { type: 'tool-removal'; toolName: string }
  export type ContentBlock =
    | TextBlock | ReasoningBlock | ToolCallBlock | ImageBlock | FileBlock
    | ToolAdditionBlock | ToolRemovalBlock
  export type ContentBlockType = ContentBlock['type']

  export type MessageSource =
    | { kind: 'user' }
    | { kind: 'model'; provider: string; model: string; replayState?: unknown }
    | { kind: 'tool'; callId: ToolCallId }
    | { kind: 'system-prompt' }

  interface MessageBase {
    readonly id: MessageId
    readonly content: readonly ContentBlock[]
    readonly source: MessageSource
  }
  export interface SystemMessage extends MessageBase { readonly role: 'system' }
  export interface DeveloperMessage extends MessageBase { readonly role: 'developer' }
  export interface UserMessage extends MessageBase { readonly role: 'user' }
  export interface AssistantMessage extends MessageBase { readonly role: 'assistant' }
  export interface ToolResultMessage extends MessageBase {
    readonly role: 'tool'
    readonly toolCallId: ToolCallId
    readonly isError?: boolean
  }
  export type Message = SystemMessage | DeveloperMessage | UserMessage | AssistantMessage | ToolResultMessage
  export interface RequestUserInput {
    readonly role: 'user'
    readonly content: UserMessage['content']
  }
  export type RequestMessage = Message | RequestUserInput

  // ---- 流协议(dsh-llm/src/types.ts)----
  export interface LlmFailure {
    readonly message: string
    readonly code: string
    readonly status?: number
  }
  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted'; failure: LlmFailure }
    | { kind: 'error'; failure: LlmFailure }
  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    /** 未命中缓存的输入 token(DeepSeek prompt_cache_miss_tokens);用于命中率 */
    cacheMissTokens?: number
    reasoningTokens?: number
  }
  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: ContentBlockType }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'finish'; reason: FinishReason; replayState?: unknown }

  export interface ToolSchema {
    deferLoading?: true
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  export interface GenerateOptions {
    provider: string
    model: string
    reasoningEffort?: ReasoningEffortId
    messages: RequestMessage[]
    system?: string
    tools?: ToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
  }
  export interface LlmResolvedModelInfo {
    provider: string
    id: string
    name: string
    defaultMaxTokens?: number
    /** 可选 reasoning 档位元数据;缺省时 LlmRuntime 拒绝一切显式 reasoningEffort */
    reasoning?: {
      efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[]
      defaultEffort?: ReasoningEffortId
    }
  }

  // ---- LLM 适配层 ----
  export abstract class LlmAdapter {
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
    /** 基类默认返回无能力元数据的模型信息;需要 reasoningEffort 的适配器应 override */
    resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  }
  export function ToolCallId(s: string): ToolCallId
  export function createUserMessage(input: {
    content: readonly ContentBlock[]
    source: { kind: 'user' }
  }): UserMessage

  // ---- 工具 ----
  export interface ToolRunContext {
    readonly signal: AbortSignal
    /** DSH 真实执行身份字段(见 vendor dsh-tools ToolRunContext);窄面声明按需补 */
    readonly callId?: string
    readonly rootCallId?: string
  }
  export interface ToolDefinition extends ToolSchema {
    readonly output: {
      schema: unknown
      render(args: unknown, value: unknown): ContentBlock[]
    }
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>
    timeoutMs?: number
    isConcurrencySafe?(args: unknown): boolean
  }
  /** defineTool 的窄化声明:DSH 原版是精确的条件类型推断,这里只保证可用。 */
  export function defineTool<A = Record<string, unknown>>(options: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: A, value: unknown): ContentBlock[]
    }
    execute(args: A, exec: ToolRunContext): Promise<unknown>
    timeoutMs?: number
    isConcurrencySafe?(args: A): boolean
  }): ToolDefinition

  // ---- 会话 / Agent ----
  export interface SessionEvent {
    readonly seq: number
    readonly type: string
    readonly data: unknown
  }
  export interface Session {
    readonly header: { cwd?: string }
    snapshotEvents(): SessionEvent[]
  }
  export interface AgentOptions {
    provider?: string
    model?: string
    reasoningEffort?: ReasoningEffortId
    maxTokens?: number
  }
  export interface Agent {
    readonly session: Session
    readonly status: string
    followup(message: UserMessage): void
    inject(message: UserMessage): void
    whenIdle(): Promise<void>
    cancel(options?: { keepInbox?: boolean }): Promise<void>
  }
  export interface AgentHandle {
    agent: Agent
    dispose(): Promise<void>
  }
  export type AssistantStreamFrame =
    | { readonly type: 'start'; readonly turn: number; readonly step: number }
    | { readonly type: 'chunk'; readonly index: number; readonly chunk: StreamChunk }
    | { readonly type: 'end' }

  // ---- Cordis Context 与 7 个 Service(窄面)----
  export class LlmRuntime {
    registerAdapter(providers: string[], adapter: LlmAdapter): () => void
  }
  export class SessionStore {}
  export class SessionProjectionRegistry {}
  export class SystemPrompt {}
  export class ToolRuntime {
    register(definition: ToolDefinition): () => void
  }
  export class AgentRegistry {
    create(options: {
      sessionId: SessionId
      agentOptions?: AgentOptions
      meta?: { cwd?: string }
    }): Promise<AgentHandle>
  }
  export class AgentLoop {
    create(id: SessionId, options?: AgentOptions): Promise<Agent>
  }
  export class Context {
    constructor()
    plugin(service: unknown, config?: unknown): Promise<unknown>
    on(event: string, callback: (...args: never[]) => void): () => void
    /** 注册一个无名类服务(如 approval seam);返回注销函数 */
    provide(name: string, value: unknown): () => void
    readonly fiber: { dispose(): Promise<void> }
    readonly llm: LlmRuntime
    readonly sessions: SessionStore
    readonly sessionProjections: SessionProjectionRegistry
    readonly systemPrompt: SystemPrompt
    readonly tools: ToolRuntime
    readonly agents: AgentRegistry
    readonly agentLoop: AgentLoop
  }
  export function SessionId(s: string): SessionId
}
