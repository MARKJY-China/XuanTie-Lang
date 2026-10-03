/**
 * 工具审批:内嵌卡片队列(替代早期的全局模态)。
 * 卡片渲染在消息列表与输入区之间(#ai-approvals),不阻塞滚动/打字;
 * DSH 并发池可同时挂多个 ask —— 每张卡片独立裁决,纵向堆叠即天然队列。
 * fail-closed:signal abort / dismissAll(关面板、清会话)一律按 deny 结算。
 * 本模块 import 期不触 DOM,Node 冒烟可安全打包。
 */

export interface ApprovalPrompt {
  /** 工具名(write_file / run_command) */
  toolName: string
  /** 一句话说明(卡片副标题) */
  summary: string
  /** 待批准内容预览(路径+前 500 字 / 完整命令行) */
  detail: string
  /** run_command 时显示「批准并加入白名单」 */
  showWhitelist?: boolean
  /** 中止信号(turn 取消/关面板时撤下该问,按 deny 结算) */
  signal?: AbortSignal
}

export type ApprovalVerdict = 'allow' | 'deny' | 'allow-whitelist'

interface Pending {
  card: HTMLElement
  settle: (v: ApprovalVerdict) => void
}

export class ApprovalLane {
  private pending = new Set<Pending>()

  constructor(private host: HTMLElement) {}

  /** 待裁决数量(UI 状态展示用)。 */
  get size(): number {
    return this.pending.size
  }

  request(prompt: ApprovalPrompt): Promise<ApprovalVerdict> {
    return new Promise<ApprovalVerdict>((resolve) => {
      const card = document.createElement('div')
      card.className = 'ai-appr-card'

      const head = document.createElement('div')
      head.className = 'ai-appr-head'
      const icon = document.createElement('i')
      icon.className = 'codicon codicon-shield'
      const title = document.createElement('span')
      title.className = 'ai-appr-title'
      title.textContent = '操作审批'
      const kind = document.createElement('span')
      kind.className = 'ai-appr-kind'
      kind.textContent = prompt.toolName === 'run_command' ? '执行命令' : '写入文件'
      head.append(icon, title, kind)

      const summary = document.createElement('div')
      summary.className = 'ai-appr-summary'
      summary.textContent = prompt.summary

      const detail = document.createElement('pre')
      detail.className = 'ai-appr-detail'
      detail.textContent = prompt.detail

      const btns = document.createElement('div')
      btns.className = 'ai-appr-btns'

      const entry: Pending = {
        card,
        settle: (v) => {
          this.pending.delete(entry)
          card.remove()
          resolve(v)
        },
      }

      const mkBtn = (label: string, cls: string, verdict: ApprovalVerdict): HTMLButtonElement => {
        const b = document.createElement('button')
        b.className = cls
        b.textContent = label
        b.addEventListener('click', () => entry.settle(verdict))
        return b
      }
      btns.appendChild(mkBtn('拒绝', 'mbtn', 'deny'))
      btns.appendChild(mkBtn('允许一次', 'mbtn primary', 'allow'))
      if (prompt.showWhitelist) {
        btns.appendChild(mkBtn('批准并加入白名单', 'mbtn', 'allow-whitelist'))
      }

      card.append(head, summary, detail, btns)
      this.pending.add(entry)
      this.host.appendChild(card)

      if (prompt.signal) {
        const onAbort = (): void => entry.settle('deny')
        if (prompt.signal.aborted) onAbort()
        else prompt.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 关面板/清会话:未裁决的一律按 deny 结算(fail-closed)。 */
  dismissAll(): void {
    for (const entry of [...this.pending]) entry.settle('deny')
  }
}
