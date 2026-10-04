/**
 * DSH agent 运行时工厂(Phase-2)。
 * 首次调用 createAgentRuntime 时才动态 import('@dsh-core') 加载 665KB 内核 chunk,
 * 不进 IDE 主 chunk;内核未加载前本模块只有类型与少量常量。
 *
 * Phase-3 面板消费方式:
 *   const runtime = await createAgentRuntime({
 *     channel: officialChannel(account.baseUrl, account.cookie),   // 或 customChannel(p.baseUrl, p.apiKey)
 *     model: accountOrProvider.model,
 *     tools: ideTools,                                            // defineTool 产物,可空
 *   })
 *   const session = await runtime.createSession()
 *   const offStream = session.onAssistantStream(frame => ...)     // 增量渲染(text-delta 等)
 *   const offEvent  = session.onSessionEvent(ev => ...)           // 耐久事件流(tool/call、turn/end 等)
 *   await session.send('读一下 main.xt')                           // 一个完整 turn(含工具回灌)
 *   ... offStream(); offEvent(); await session.dispose(); await runtime.dispose()
 */
import type {
  Agent,
  AgentHandle,
  AssistantStreamFrame,
  Context,
  ReasoningEffortId,
  SessionEvent,
  ToolDefinition,
} from '@dsh-core'
import { OpenAiCompatAdapter, type OpenAiChannelConfig, type TurnAttachment } from './adapter-openai'
import type { SseTransport } from './transport'

export interface ApprovalGateRequest {
  toolName: string
  callId: string
  /** pre-execute 监听器构造的待批准内容描述(路径/命令预览) */
  reason?: string
  signal?: AbortSignal
}

export interface AgentRuntimeConfig {
  /** 通道(officialChannel / customChannel 构造,见 adapter-openai.ts) */
  channel: OpenAiChannelConfig
  /** 模型 id;官方通道下服务端强制覆盖,此处作占位与自定义通道的实际选择 */
  model: string
  /** provider 路由名(注册表键),默认 'openai' */
  provider?: string
  /** 系统提示 persona 前缀,缺省用 IDE 助手人设 */
  systemPrompt?: string
  /** 工程指令块(AGENTS.md/XuanTieAI.md 内容,由 agent-mode 读取);拼在 persona 之后 */
  projectInstructions?: string
  /** 会话级 reasoning effort(如 'low'/'high'),缺省由模型默认 */
  reasoningEffort?: string
  /** 每请求 max_tokens 上限,缺省由服务端/模型默认 */
  maxTokens?: number
  /** 工具表(Phase-3 喂 IDE 文件/终端工具),可空 */
  tools?: ToolDefinition[]
  /**
   * 审批 seam:gate 命中(toolName)的工具在 tools/pre-execute 返回 ask,
   * 经 ctx.provide('approval') 挂的 request 弹窗等用户决定;
   * allowed-once 放行,rejected/cancelled 拒绝(DSH 缺 approval 服务时 fail-closed 自动拒绝)。
   */
  approval?: {
    /** 返回 true 表示该次调用需逐次人工批准(args 供白名单类规则判定) */
    gate(toolName: string, args: unknown): boolean
    request(req: ApprovalGateRequest): Promise<'allowed-once' | 'rejected' | 'cancelled'>
    /** 由 exec 构造审批 reason(内容预览);callId 供调用方按调用关联预览 */
    describe?(toolName: string, args: unknown, callId: string): string
  }
  /** 传输实现,缺省动态加载 Tauri WebView 桥;Node 冒烟注入 stub */
  transport?: SseTransport
  /** 本轮待发附件(Agent 媒体注入;见 adapter-openai TurnAttachment) */
  getTurnAttachments?: () => readonly TurnAttachment[]
}

export interface AgentSessionHandle {
  readonly id: string
  /** 发一条用户消息并等待整个 turn 完成(含全部工具往返)。事件经 on* 订阅流出。 */
  send(text: string): Promise<void>
  /** 中止当前 turn(保留收件箱)。 */
  cancel(): Promise<void>
  /** 订阅增量流帧(start/chunk/end;chunk.chunk 即 StreamChunk)。返回退订函数。 */
  onAssistantStream(callback: (frame: AssistantStreamFrame) => void): () => void
  /** 订阅本会话的耐久事件(turn/start、tool/call、tool/result、turn/end 等)。返回退订函数。 */
  onSessionEvent(callback: (event: SessionEvent) => void): () => void
  /** 当前 agent 状态('idle' | 'running' 等,透传 DSH)。 */
  status(): string
  /** 销毁本会话(stop/drain、注销、移除 session、回卷 scope)。 */
  dispose(): Promise<void>
}

export interface AgentRuntime {
  /** 创建 agent 会话;sessionId 缺省生成 xt-<uuid>。 */
  createSession(sessionId?: string): Promise<AgentSessionHandle>
  /** 销毁整个运行时(所有会话随之回卷)。 */
  dispose(): Promise<void>
}

const DEFAULT_PERSONA =
  '你是玄铁铸造厂 IDE 的内嵌编程助手,精通玄铁语言(.xt,中文关键字)。遵守工作准则:\n' +
  '- 少说废话,直接干活:不寒暄、不复述用户的话、不预告"我准备做什么";回复以行动结果开头。\n' +
  '- 事实优先:所有代码判断基于实际读到的文件内容;没读过先 read_file,读不到就明说,严禁凭直觉猜逻辑。\n' +
  '- 零信任:调用任何接口/路径/命令前先核实其存在(docs_search/环境快照/read_file),不臆造 API、语法与文件。\n' +
  '- 不确定就标注"可能/推测";信息不足直接回答"信息不足",严禁编造。\n' +
  '- 宁可报错退出,绝不静默跳过:发现问题如实报告,不掩盖。\n' +
  '- 语言问题先看系统提示词中的<玄铁语言基础认知>块(基础语法事实基准),细节再 docs_search\n' +
  '  检索官方文档;严禁按其他语言直觉推演语法(如把 elif 写成「否 若」——玄铁是「抑」)。\n' +
  '  环境问题查系统提示词中的环境快照,\n' +
  '  禁止用 where/dir/find 全盘探测(环境快照已含编译器/库/工程路径)。\n' +
  '- 环境可用性与基础语义已由 IDE 自检覆盖(见快照「本地玄铁环境自检」段):直接采用其中事实,\n' +
  '  禁止写探针/冒烟/前置测试去验证基础行为,也不要用 chcp/echo/findstr 探测环境。\n' +
  '  不确定的新语法/库用法用 check_code 工具验证(约 0.5 秒,临时文件在 .foundry/ 内自动清理);禁止手写探针/测试文件到工程根(临时文件只许放 .foundry/);\n' +
  '- 库(渲染/UI/数组/HTTP 等)用法:先 docs_search 检索官方文档;需要精确 API 签名时,\n' +
  '  直接 read_file 读环境快照「官方库目录」下的库源码(只读放行),不要凭记忆猜测 API。\n' +
  '你具备联网能力:web_search 搜索、web_fetch 打开网页(含 SPA,自动无头渲染)。用户给链接或要查资料时' +
  '主动调用,不要以"我无法浏览网页"为由拒绝。'

export async function createAgentRuntime(config: AgentRuntimeConfig): Promise<AgentRuntime> {
  // 懒加载:665KB 内核只在此处首次载入;vite 会把 @dsh-core 打成独立 chunk
  const dsh = await import('@dsh-core')
  const transport =
    config.transport ?? new (await import('./transport-tauri')).TauriSseTransport()
  const provider = config.provider ?? 'openai'

  const ctx: Context = new dsh.Context()
  // 服务装配顺序与 sdk-minimal 剖面一致(砍 shell/subprocess/persistence/sandbox 等执行层)
  await ctx.plugin(dsh.LlmRuntime)
  await ctx.plugin(dsh.SessionStore)
  await ctx.plugin(dsh.SessionProjectionRegistry)
  await ctx.plugin(dsh.SystemPrompt, { personaPrefix: (config.systemPrompt ?? DEFAULT_PERSONA) + (config.projectInstructions ?? '') })
  await ctx.plugin(dsh.ToolRuntime)
  await ctx.plugin(dsh.AgentRegistry)
  await ctx.plugin(dsh.AgentLoop, { agents: [] })

  ctx.llm.registerAdapter([provider], new OpenAiCompatAdapter(config.channel, transport, config.getTurnAttachments))
  for (const tool of config.tools ?? []) ctx.tools.register(tool)

  // 审批 seam:gate 命中的工具在 pre-execute 挂 ask,由我们 provide 的 approval 服务弹窗裁决
  if (config.approval) {
    const approval = config.approval
    ctx.provide('approval', {
      request: (req: { toolName: string; callId: string; reason?: string; signal?: AbortSignal }) =>
        approval.request(req),
    })
    ctx.on(
      'tools/pre-execute',
      (
        exec: { name: string; arguments: unknown; callId: string },
        next: () => Promise<unknown>,
      ): Promise<unknown> => {
        if (!approval.gate(exec.name, exec.arguments)) return next()
        const reason = approval.describe
          ? approval.describe(exec.name, exec.arguments, exec.callId)
          : `tool "${exec.name}" requires approval`
        return Promise.resolve({ kind: 'ask', reason })
      },
    )
  }

  return {
    async createSession(sessionId?: string): Promise<AgentSessionHandle> {
      const id = sessionId ?? `xt-${crypto.randomUUID()}`
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: dsh.SessionId(id),
        agentOptions: {
          provider,
          model: config.model,
          ...(config.reasoningEffort
            ? { reasoningEffort: config.reasoningEffort as ReasoningEffortId }
            : {}),
          ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        },
      })
      const agent: Agent = handle.agent
      return {
        id,
        async send(text: string): Promise<void> {
          agent.followup(
            dsh.createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            }),
          )
          await agent.whenIdle()
        },
        cancel: () => agent.cancel(),
        onAssistantStream(callback) {
          return ctx.on('agent/assistant-stream', (payload: { agent: Agent; frame: AssistantStreamFrame }) => {
            if (payload.agent === agent) callback(payload.frame)
          })
        },
        onSessionEvent(callback) {
          return ctx.on('session/event', (session: unknown, event: SessionEvent) => {
            if (session === agent.session) callback(event)
          })
        },
        status: () => agent.status,
        dispose: () => handle.dispose(),
      }
    },
    dispose: () => ctx.fiber.dispose(),
  }
}
