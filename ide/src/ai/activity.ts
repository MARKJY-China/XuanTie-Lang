/**
 * ActivityTracker:agent/简单对话直播期的「正在工作」状态机(DSH Web UI 状态行式设计)。
 * 由面板事件驱动,任何时刻给出一个明确状态;时间由调用方注入(now 参数),
 * 纯逻辑可单测,不触 DOM。turn-end 后 view() 返回 null(状态行消失)。
 *
 * 状态优先级:等待审批 > 工具执行 > 思考中 > 撰写中 > 连接中。
 * 思考计时从首个 reasoning-delta 起累计(多 step 不重置);
 * 工具结果后回到「思考中…」(等下一帧)。
 */

export type ToolStatus = 'running' | 'awaiting-approval' | 'done' | 'denied' | 'failed'

/** 耗时格式化(全面板唯一):<100ms 显示毫秒(45ms),<10s 一位小数(0.4s/2.1s),≥10s 取整(12s)。 */
export function fmtDur(ms: number): string {
  const v = Math.max(0, ms)
  if (v < 100) return `${Math.round(v)}ms`
  const s = v / 1000
  return s < 10 ? `${Math.round(s * 10) / 10}s` : `${Math.round(s)}s`
}

export type ActivityEvent =
  | { type: 'turn-start' }
  | { type: 'reasoning' }
  | { type: 'text' }
  | { type: 'tool-call'; callId: string; name: string; summary: string }
  | { type: 'tool-status'; callId: string; status: ToolStatus }
  | { type: 'turn-end' }

export interface ActivityView {
  /** 状态行文本(秒数已按 now 渲染好) */
  text: string
}

interface ToolSlot {
  name: string
  summary: string
  since: number
  awaiting: boolean
}

function dur(now: number, since: number): string {
  return fmtDur(now - since)
}

export class ActivityTracker {
  private phase: 'connecting' | 'thinking' | 'writing' | 'done' = 'connecting'
  /** 首个 reasoning-delta 的时刻;-1 = 本 turn 还没有过思考(累计计时的起点) */
  private thinkingSince = -1
  private readonly tools = new Map<string, ToolSlot>()

  /** 首个思考时刻(面板思考块头共用这个起点做累计时长)。 */
  get firstThinkingAt(): number {
    return this.thinkingSince
  }

  event(ev: ActivityEvent, now: number): void {
    switch (ev.type) {
      case 'turn-start':
        this.phase = 'connecting'
        return
      case 'reasoning':
        if (this.thinkingSince < 0) this.thinkingSince = now
        this.phase = 'thinking'
        return
      case 'text':
        this.phase = 'writing'
        return
      case 'tool-call':
        this.tools.set(ev.callId, { name: ev.name, summary: ev.summary, since: now, awaiting: false })
        return
      case 'tool-status': {
        const slot = this.tools.get(ev.callId)
        if (!slot) return
        if (ev.status === 'awaiting-approval') {
          slot.awaiting = true
        } else if (ev.status === 'running') {
          slot.awaiting = false
        } else {
          // 终态:移出执行表,回到「思考中…」等下一帧
          this.tools.delete(ev.callId)
          this.phase = 'thinking'
        }
        return
      }
      case 'turn-end':
        this.phase = 'done'
        return
    }
  }

  /** 当前状态行;null = 隐藏(turn 已结束)。 */
  view(now: number): ActivityView | null {
    if (this.phase === 'done') return null
    const awaiting = [...this.tools.values()].find((t) => t.awaiting)
    if (awaiting) return { text: '等待操作审批…' }
    if (this.tools.size > 1) return { text: `正在执行 ${this.tools.size} 个工具…` }
    const only = [...this.tools.values()][0]
    if (only) {
      const summary = only.summary.length > 30 ? `${only.summary.slice(0, 30)}…` : only.summary
      return { text: `正在执行 ${only.name}${summary ? `(${summary})` : ''}… ${dur(now, only.since)}` }
    }
    switch (this.phase) {
      case 'connecting':
        return { text: '连接模型中…' }
      case 'thinking':
        return this.thinkingSince >= 0
          ? { text: `思考中… ${dur(now, this.thinkingSince)}` }
          : { text: '思考中…' }
      case 'writing':
        return { text: '正在撰写回复…' }
    }
  }
}
