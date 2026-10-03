/**
 * Agent 模式控制器:面板(aichat.ts)与 DSH 运行时之间的唯一接线层。
 * 本模块只被面板动态 import(Agent 开关首次开启时),因此可以静态引用
 * runtime/adapter/tools —— 全部留在 665KB 懒加载 chunk 内,不进主 chunk。
 *
 * 职责:按当前通道/工程根建 runtime+session(配置变了自动重建)、
 * 把 AssistantStreamFrame 与 SessionEvent 翻译成面板的 AgentTurnUI 回调、
 * 挂审批弹窗(write_file/run_command 逐次批准,拒绝即 deny)。
 */
import { createAgentRuntime, type AgentRuntime, type AgentSessionHandle } from './runtime'
import type { OpenAiChannelConfig } from './adapter-openai'
import { createIdeTools, APPROVAL_GATED_TOOLS, approvalPreview, commandToken } from './tools'
import type { ApprovalPrompt, ApprovalVerdict } from './approval'
import type { SseTransport } from './transport'
import { aiLog } from '../log-bus'
import type { AssistantStreamFrame, SessionEvent } from '@dsh-core'

/** Agent 审批模式:confirm(变更前确认,默认)/auto-edit(自动编辑)/full-control(完全控制)。 */
export type AgentApprovalMode = 'confirm' | 'auto-edit' | 'full-control'

export interface AgentModeDeps {
  /** 当前通道(随面板目标切换) */
  getChannel(): OpenAiChannelConfig
  getModel(): string
  getWorkspace(): string
  /** 思考档位(off/none/minimal/low/medium/mid/high/xhigh/max) */
  getThinking(): string
  /** 审批模式(切换对下一次发送生效,configKey 含模式,变了重建 runtime) */
  getAgentMode(): AgentApprovalMode
  /** run_command 免审批白名单(命令首 token;live 读取,改动无需重建 runtime) */
  getCmdWhitelist(): string[]
  /** 「批准并加入白名单」回调:把 token 持久化到设置 */
  addCmdToken(token: string): void
  /** 审批 UI(内嵌卡片队列;由面板注入,Node 冒烟注入 stub) */
  requestApproval(prompt: ApprovalPrompt): Promise<ApprovalVerdict>
  /** 传输实现(缺省 Tauri WebView 桥;Node 冒烟注入 stub) */
  transport?: SseTransport
  /** write_file 成功落盘后通知(绝对路径);IDE 主线程据此刷新文件树与未脏编辑器 */
  onFileWritten?(absPath: string): void
  /** write_file 的行级 diff(执行时算好);面板据此渲染「写入 <路径> +N -M」标题 */
  onWriteDiff?(info: { callId: string; path: string; added: number; removed: number; isNew: boolean }): void
  /** 读取工程根目录的指令文件(AGENTS.md / XuanTieAI.md;面板注入,Node 冒烟注入 stub) */
  loadProjectInstructions?(): Promise<Array<{ name: string; content: string }>>
  /** 读取玄铁文档库索引(未拉取过返回 null;面板注入,Node 冒烟注入 stub) */
  loadDocsIndex?(): Promise<{ dir: string; index: string; count: number } | null>
  /** 开发环境快照(编译器/包管理器路径与版本、工程根/入口、官方库目录;IDE 实测注入) */
  getEnvSnapshot?(): Promise<string>
}

/** 面板档位 → OpenAI reasoning_effort;off/none 省略该参数,其余原样透传(含 xhigh/max)。
 *  档位表由服务端 aiConfig 下发、后台可配;上游不支持某档位时由上游报错,客户端不做 clamp。 */
export function thinkingToEffort(thinking: string): string | undefined {
  switch (thinking) {
    case 'off':
    case 'none':
      return undefined
    case 'mid':
      return 'medium' // mid 是 medium 的历史别名(aiThinkingAllowed 同列)
    default:
      return thinking
  }
}

export type ToolCardStatus = 'running' | 'awaiting-approval' | 'done' | 'denied' | 'failed'

export interface AgentTurnUI {
  /** step 边界:每个 step 一条 start → chunks → end(面板按 step 开新文本段) */
  onStepStart?(): void
  onStepEnd?(): void
  onTextDelta(delta: string): void
  onReasoningDelta(delta: string): void
  onToolCall(info: { callId: string; name: string; arguments: string }): void
  onToolStatus(callId: string, status: ToolCardStatus, detail?: string): void
  onUsage(usage: { inputTokens: number; outputTokens: number; totalTokens?: number }): void
}

export interface AgentTurnResult {
  ok: boolean
  /** 'cancelled' 表示用户中断 */
  error?: string
}

interface TurnEndData {
  reason?: { kind?: string; error?: { message?: string } }
}

/** session 事件的关键字段摘要(日志用;不含正文载荷)。 */
function summarizeEventData(type: string, data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (type === 'tool/call') return { callId: data.callId, name: data.name }
  if (type === 'tool/result') {
    const m = data.message as { toolCallId?: string; isError?: boolean } | undefined
    return { toolCallId: m?.toolCallId, isError: m?.isError }
  }
  if (type === 'turn/end' || type === 'step/end' || type === 'step/start' || type === 'turn/start') {
    return { turn: data.turn, step: data.step, reason: (data.reason as { kind?: string } | undefined)?.kind }
  }
  return undefined
}

export class AgentMode {
  private runtime: AgentRuntime | undefined
  private session: AgentSessionHandle | undefined
  private configKey = ''
  private offs: Array<() => void> = []
  private ui: AgentTurnUI | undefined
  private readonly denied = new Set<string>()
  private readonly previews = new Map<string, { summary: string; detail: string }>()
  private turnEnd: AgentTurnResult | undefined

  constructor(private deps: AgentModeDeps) {}

  /** 配置(channel/model/workspace/模式)变更是销毁重建;同一配置复用 session(多轮上下文连续)。 */
  private async ensureSession(): Promise<AgentSessionHandle> {
    const channel = this.deps.getChannel()
    const effort = thinkingToEffort(this.deps.getThinking())
    const mode = this.deps.getAgentMode()
    const key = `${channel.url}|${channel.cookie ?? ''}|${channel.auth ?? ''}|${this.deps.getModel()}|${this.deps.getWorkspace()}|${effort ?? ''}|${mode}`
    if (this.session && key === this.configKey) return this.session
    await this.disposeInner()

    await this.loadInstructions()
    const dsh = await import('@dsh-core')
    this.runtime = await createAgentRuntime({
      channel,
      model: this.deps.getModel(),
      reasoningEffort: effort,
      projectInstructions: this.instructions?.block ?? '',
      ...(this.deps.transport ? { transport: this.deps.transport } : {}),
      tools: createIdeTools(dsh.defineTool, {
        workspace: this.deps.getWorkspace(),
        // 文档库根必须传入:read_file/list_files 双根白名单靠它,漏传会让 AI 读文档全部越界
        ...(this.docsDir ? { docsDir: this.docsDir } : {}),
        ...(this.deps.onFileWritten ? { onFileWritten: this.deps.onFileWritten } : {}),
        ...(this.deps.onWriteDiff ? { onWriteDiff: this.deps.onWriteDiff } : {}),
      }),
      approval: {
        // 三模式 × 白名单 gate:confirm=写文件+命令都批;auto-edit=写文件免批、命令仍批;
        // full-control=全免;run_command 命中白名单(命令首 token,大小写不敏感)任何模式都免批。
        gate: (name, args) => {
          if (!APPROVAL_GATED_TOOLS.has(name)) return false
          if (mode === 'full-control') return false
          if (name === 'run_command') {
            const command = String((args as { command?: unknown } | undefined)?.command ?? '')
            const token = commandToken(command).toLowerCase()
            if (token && this.deps.getCmdWhitelist().some((w) => w.toLowerCase() === token)) return false
            return true
          }
          return mode === 'confirm'
        },
        describe: (name, args, callId) => {
          const preview = approvalPreview(name, args)
          this.previews.set(callId, preview)
          return `${preview.summary}\n${preview.detail}`
        },
        request: async (req) => {
          const preview = this.previews.get(req.callId) ?? { summary: `Agent 请求调用工具: ${req.toolName}`, detail: req.reason ?? '' }
          aiLog('info', 'agent-mode', `审批请求: ${req.toolName}`, preview.summary)
          this.ui?.onToolStatus(req.callId, 'awaiting-approval')
          const verdict = await this.deps.requestApproval({
            toolName: req.toolName,
            summary: preview.summary,
            detail: preview.detail,
            showWhitelist: req.toolName === 'run_command',
            signal: req.signal,
          })
          aiLog('info', 'agent-mode', `审批裁决: ${req.toolName} → ${verdict}`)
          this.previews.delete(req.callId)
          if (verdict === 'allow' || verdict === 'allow-whitelist') {
            if (verdict === 'allow-whitelist') {
              const token = commandToken(preview.detail)
              if (token) this.deps.addCmdToken(token)
            }
            this.ui?.onToolStatus(req.callId, 'running')
            return 'allowed-once'
          }
          this.denied.add(req.callId)
          this.ui?.onToolStatus(req.callId, 'denied')
          return req.signal?.aborted ? 'cancelled' : 'rejected'
        },
      },
    })
    this.session = await this.runtime.createSession()
    this.configKey = key

    this.offs.push(
      this.session.onAssistantStream((frame: AssistantStreamFrame) => {
        if (!this.ui) return
        if (frame.type === 'start') {
          aiLog('debug', 'agent-mode', 'stream start')
          this.ui.onStepStart?.()
          return
        }
        if (frame.type === 'end') {
          aiLog('debug', 'agent-mode', `stream end(${frame.type})`)
          this.ui.onStepEnd?.()
          return
        }
        const chunk = frame.chunk
        if (chunk.type === 'text-delta') this.ui.onTextDelta(chunk.text)
        else if (chunk.type === 'reasoning-delta') this.ui.onReasoningDelta(chunk.text)
        else if (chunk.type === 'usage') this.ui.onUsage(chunk.usage)
        else if (chunk.type === 'finish') aiLog('info', 'agent-mode', `assistant finish: ${chunk.reason.kind}`)
      }),
      this.session.onSessionEvent((event: SessionEvent) => {
        if (!this.ui) return
        const data = event.data as Record<string, unknown>
        aiLog('info', 'agent-mode', `session event: ${event.type}`, summarizeEventData(event.type, data))
        if (event.type === 'tool/call') {
          this.ui.onToolCall({
            callId: String(data.callId ?? ''),
            name: String(data.name ?? ''),
            arguments: String(data.arguments ?? ''),
          })
          this.ui.onToolStatus(String(data.callId ?? ''), 'running')
        } else if (event.type === 'tool/result') {
          const message = data.message as { toolCallId?: string; isError?: boolean; content?: { text?: string }[] } | undefined
          const callId = String(message?.toolCallId ?? '')
          if (this.denied.has(callId)) {
            this.denied.delete(callId)
            return // 保持「被拒绝」状态,不被失败回执覆盖
          }
          const isError = message?.isError === true
          const detail = (message?.content ?? []).map((b) => b.text ?? '').join('').slice(0, 2000)
          this.ui.onToolStatus(callId, isError ? 'failed' : 'done', detail)
        } else if (event.type === 'turn/end') {
          const reason = (data as TurnEndData).reason
          if (!reason || reason.kind === 'completed') {
            this.turnEnd = { ok: true }
          } else if (reason.kind === 'aborted') {
            this.turnEnd = { ok: false, error: 'cancelled' }
          } else if (reason.kind === 'max-tokens') {
            this.turnEnd = { ok: true, error: '输出达到 token 上限,可能不完整' }
          } else {
            this.turnEnd = { ok: false, error: reason.error?.message ?? `turn 结束原因: ${reason.kind}` }
          }
        }
      }),
    )
    return this.session
  }

  /** 跑一个完整 turn(含全部工具往返与审批),resolve 时 turn 已结束。 */
  async send(text: string, ui: AgentTurnUI): Promise<AgentTurnResult> {
    this.ui = ui
    this.turnEnd = undefined
    try {
      const session = await this.ensureSession()
      await session.send(text)
      return this.turnEnd ?? { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.ui = undefined
    }
  }

  /** 工程指令(懒加载一次,会话重建不重读——同一工程生命周期内文件不变) */
  private instructions: { names: string[]; block: string } | undefined
  /** 上下文压缩摘要(IDE 面板注入;随会话重建重携) */
  private compressionNote = ''
  private docsCount = 0
  private docsDir = ''

  /** 读取并缓存工程指令(AGENTS.md / XuanTieAI.md);返回文件名列表供 UI 显示引用提示。
   *  读取失败按"无指令"处理,绝不阻塞 Agent。 */
  async loadInstructions(): Promise<string[]> {
    if (this.instructions) return this.instructions.names;
    let files: Array<{ name: string; content: string }> = [];
    try {
      files = (await this.deps.loadProjectInstructions?.()) ?? [];
    } catch (error) {
      aiLog('warn', 'agent-mode', `工程指令读取失败(按无指令继续): ${error instanceof Error ? error.message : String(error)}`);
      files = [];
    }
    files = files.filter((f) => f.content.trim().length > 0);
    const names = files.map((f) => f.name);
    // 开发环境快照放最前:编译器/库/工程事实由 IDE 实测提供,消除会话开局的探测开销
    let env = '';
    try {
      env = (await this.deps.getEnvSnapshot?.()) ?? '';
    } catch (error) {
      aiLog('warn', 'agent-mode', `环境快照读取失败(跳过): ${error instanceof Error ? error.message : String(error)}`);
      env = '';
    }
    let block = env;
    if (this.compressionNote) {
      block +=
        '\n\n<历史对话摘要 本会话较早前的对话已被 IDE 自动压缩为下述要点,继续任务时以此为准;细节可按需重新读取文件核实>\n' +
        this.compressionNote +
        '\n</历史对话摘要>';
    }
    if (files.length > 0) {
      block +=
        '\n\n<工程指令 来源:当前工程根目录,由项目维护者编写,必须遵守>\n' +
        files.map((f) => `## ${f.name}\n${f.content}`).join('\n\n') +
        '\n</工程指令>';
      aiLog('info', 'agent-mode', `已携带工程指令: ${names.join('、')}(${block.length} 字符)`);
    }
    // 玄铁语言文档索引(全局知识,与工程无关):只给索引与本地路径,
    // 需要具体知识时由模型用 read_file 读对应单篇——全文不进上下文
    let docs: { dir: string; index: string; count: number } | null = null;
    try {
      docs = (await this.deps.loadDocsIndex?.()) ?? null;
    } catch (error) {
      aiLog('warn', 'agent-mode', `文档索引读取失败(按无文档继续): ${error instanceof Error ? error.message : String(error)}`);
      docs = null;
    }
    this.docsCount = docs?.count ?? 0;
    this.docsDir = docs?.dir ?? '';
    if (docs) {
      block +=
        '\n\n<玄铁语言文档 官方文档已下载到本地:' +
        docs.dir +
        ',共 ' +
        docs.count +
        ' 篇>\n' +
        docs.index +
        '\n读取方式:用 read_file 打开绝对路径,即 ' +
        docs.dir +
        '\\' +
        ' + 索引中的相对路径(例:' +
        docs.dir +
        '\\GUIDE.md)。不要在其他目录(工程目录/系统目录)找文档。\n</玄铁语言文档>';
      aiLog('info', 'agent-mode', `已携带玄铁文档索引(${docs.count} 条)`);
    }
    this.instructions = { names, block };
    return names;
  }

  /** 已加载的指令文件名(未加载/无文件时为空数组) */
  getLoadedInstructions(): string[] {
    return this.instructions?.names ?? [];
  }

  /** 已加载的文档索引条数(未拉取文档时为 0) */
  getLoadedDocsCount(): number {
    return this.docsCount;
  }

  /** 丢弃当前会话(回退对话/重生成时调用):泄漏风险的关键点是"清引用必须同步"——
   *  若只异步 dispose 而不立刻清 this.session,紧随其后的发送会在旧会话上继续(被回退的
   *  消息仍在模型上下文里,残留)。故本方法先同步清引用与 configKey(强制下次 ensureSession
   *  重建),再异步销毁旧会话。 */
  async dropSession(): Promise<void> {
    const stale = this.session
    this.session = undefined
    this.configKey = ''
    for (const off of this.offs.splice(0)) off()
    this.turnEnd = undefined
    this.denied.clear()
    this.previews.clear()
    if (stale) {
      try {
        await stale.dispose()
      } catch (error) {
        aiLog('warn', 'agent-mode', `旧会话销毁失败(已强制失效引用): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 上下文压缩:记录摘要并强制重建会话——下次 ensureSession 重读环境快照/工程指令/
   *  文档索引并拼接摘要(loadInstructions 缓存一并失效)。 */
  async applyCompression(note: string): Promise<void> {
    this.compressionNote = note
    this.instructions = undefined
    await this.dropSession()
  }

  async cancel(): Promise<void> {
    await this.session?.cancel()
  }

  private async disposeInner(): Promise<void> {
    for (const off of this.offs.splice(0)) off()
    this.session = undefined
    this.configKey = ''
    await this.runtime?.dispose()
    this.runtime = undefined
  }

  /** 面板关闭时调用:销毁会话与运行时(不做跨重启持久化,v0.3 决策)。 */
  async dispose(): Promise<void> {
    await this.disposeInner()
  }
}
