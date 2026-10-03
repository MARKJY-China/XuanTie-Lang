/**
 * TurnParts:agent turn 的 parts 纯逻辑装配(直播与持久化的单一数据源)。
 * 面板把同一批 UI 回调喂给它和 DOM;Node 冒烟可脱离 DOM 直接断言段结构。
 * 时间由调用方注入(now),不触 DOM。
 */

/** 一次工具调用的持久记录(卡片现场:名称/参数/状态/结果/耗时/写入 diff)。 */
export interface ToolRecord {
  callId: string
  name: string
  args: string
  status: 'running' | 'awaiting-approval' | 'done' | 'denied' | 'failed'
  result?: string
  /** 执行耗时(毫秒,终态写入) */
  elapsedMs?: number
  /** write_file 行级 diff(老数据没有时按「写入 <路径>」显示) */
  added?: number
  removed?: number
  isNew?: boolean
}

export type TurnPart =
  | { kind: 'text'; text: string }
  | { kind: 'think'; text: string; elapsedMs?: number }
  | { kind: 'tool'; tool: ToolRecord }

export class TurnParts {
  private readonly parts: TurnPart[] = []
  private readonly tools = new Map<string, { record: ToolRecord; since: number }>()
  private textOpen = false
  private textBuf = ''
  private thinkOpen = false
  private thinkBuf = ''
  private thinkSince = -1

  stepStart(): void {
    this.closeText()
  }

  stepEnd(now: number): void {
    // 次序硬性:同一 step 内思考在前、正文在后(reasoning 先于 content),否则
    // 持久化的 parts 会把该 step 的正文排到思考之前,重启恢复后渲染顺序反转。
    this.closeThink(now)
    this.closeText()
  }

  text(delta: string): void {
    this.textOpen = true
    this.textBuf += delta
  }

  reasoning(delta: string, now: number): void {
    if (!this.thinkOpen) {
      this.thinkOpen = true
      this.thinkBuf = ''
      this.thinkSince = now
    }
    this.thinkBuf += delta
  }

  toolCall(info: { callId: string; name: string; arguments: string }, now: number): void {
    // 工具调用会打断本段流:先把当前思考段落盘(它发生在调用之前),再收正文。
    this.closeThink(now)
    this.closeText()
    const record: ToolRecord = {
      callId: info.callId,
      name: info.name,
      args: info.arguments,
      status: 'running',
    }
    this.tools.set(info.callId, { record, since: now })
    this.parts.push({ kind: 'tool', tool: record })
  }

  toolStatus(
    callId: string,
    status: ToolRecord['status'],
    detail: string | undefined,
    now: number,
  ): void {
    const slot = this.tools.get(callId)
    if (!slot) return
    slot.record.status = status
    if (detail !== undefined) slot.record.result = detail
    if (status === 'done' || status === 'failed' || status === 'denied') {
      slot.record.elapsedMs = Math.max(0, now - slot.since)
    }
  }

  /** write_file 的 diff 结果落进对应记录(标题「+N -M」与历史恢复用)。 */
  writeDiff(callId: string, diff: { added: number; removed: number; isNew: boolean }): void {
    const slot = this.tools.get(callId)
    if (!slot) return
    slot.record.added = diff.added
    slot.record.removed = diff.removed
    slot.record.isNew = diff.isNew
  }

  /** 按 callId 取工具记录(面板标题更新/徽章计时用)。 */
  tool(callId: string): ToolRecord | undefined {
    return this.tools.get(callId)?.record
  }

  private closeText(): void {
    if (!this.textOpen) return
    if (this.textBuf) this.parts.push({ kind: 'text', text: this.textBuf })
    this.textOpen = false
    this.textBuf = ''
  }

  private closeThink(now: number): void {
    if (!this.thinkOpen) return
    if (this.thinkBuf) {
      this.parts.push({
        kind: 'think',
        text: this.thinkBuf,
        elapsedMs: this.thinkSince >= 0 ? Math.max(0, now - this.thinkSince) : undefined,
      })
    }
    this.thinkOpen = false
    this.thinkBuf = ''
    this.thinkSince = -1
  }

  /** 全部 think 段拼接(ChatMsg.thinking,兼容老消费方)。 */
  thinkingText(): string {
    return this.parts
      .filter((p): p is Extract<TurnPart, { kind: 'think' }> => p.kind === 'think')
      .map((p) => p.text)
      .join('\n\n')
  }

  /** 全部 text 段拼接(ChatMsg.content)。 */
  contentText(): string {
    return this.parts
      .filter((p): p is Extract<TurnPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('\n\n')
  }

  getParts(): TurnPart[] {
    return this.parts
  }

  get length(): number {
    return this.parts.length
  }
}
