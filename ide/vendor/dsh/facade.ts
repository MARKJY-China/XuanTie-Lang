/**
 * DSH 核心链 facade:ide 运行时所需的全部符号从这里统一出口,
 * 构建产物 dist/dsh-core.mjs 经 vite alias `@dsh-core` 被 ide/src 懒加载。
 * 类型声明(手写,窄面)在 ide/src/ai/dsh/dsh-core.d.ts。
 * 重建:node ide/vendor/dsh/build.mjs(依赖 ide 根 node_modules 的 esbuild/zod)。
 */

// Cordis 内核
export { Context } from '@deepseek-ai/cordis'

// 7 个 Service(运行时工厂按序 ctx.plugin)
export { default as LlmRuntime } from '@deepseek-ai/dsh-llm'
export { default as SessionStore } from '@deepseek-ai/dsh-session'
export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
export { default as SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
export { default as ToolRuntime } from '@deepseek-ai/dsh-tools'
export { default as AgentRegistry } from '@deepseek-ai/dsh-agent'
export { default as AgentLoop } from '@deepseek-ai/dsh-agent-loop'

// LLM 适配层:基类 / 构造助手 / 品牌类型
export {
  LlmAdapter,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
export type {
  GenerateOptions,
  StreamChunk,
  ContentBlock,
  ContentBlockType,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolSchema,
  FinishReason,
  TokenUsage,
  LlmFailure,
  LlmResolvedModelInfo,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'

// 会话:品牌 id / 事件类型
export { SessionId } from '@deepseek-ai/dsh-session'
export type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

// Agent:句柄与流帧类型
export type { Agent, AgentHandle, AgentOptions, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

// 工具定义(Phase-3 喂 IDE 文件/终端工具用)
export { defineTool } from '@deepseek-ai/dsh-tools'
export type { ToolDefinition } from '@deepseek-ai/dsh-tools'
