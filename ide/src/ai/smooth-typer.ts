/**
 * SmoothTyper:Gemini 式平滑吐字器。
 * push(delta) 进缓冲,rAF 循环按自适应速率释放(基础 24 字/帧,
 * 积压越多释放越快——每帧至少吐出积压的 1/3,2000 字瞬时积压 ≤16 帧清空,
 * 滞后上限 ~270ms);step 结束/定稿/中断时 flush() 立即吐尽
 * (flush 必须先于 md 替换);dispose() 后不再触发 emit。
 * rAF 可注入(Node 单测 mock;浏览器缺省全局 requestAnimationFrame)。
 */

export interface TyperScheduler {
  raf(cb: () => void): number
  caf(id: number): void
}

const defaultScheduler: TyperScheduler = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
}

const BASE_CHARS_PER_FRAME = 24

export class SmoothTyper {
  private queue = ''
  private pending = 0
  private disposed = false

  constructor(
    private readonly emit: (text: string) => void,
    private readonly scheduler: TyperScheduler = defaultScheduler,
  ) {}

  /** 缓冲中尚未吐出的字符数(测试与滞后观测用)。 */
  get backlog(): number {
    return this.queue.length
  }

  push(delta: string): void {
    if (this.disposed || !delta) return
    this.queue += delta
    if (!this.pending) this.pending = this.scheduler.raf(this.tick)
  }

  private readonly tick = (): void => {
    this.pending = 0
    if (this.disposed || !this.queue) return
    // 自适应:基础 24 字/帧;每帧至少吐出积压的 1/3(几何追赶,滞后封顶 ~16 帧)
    const n = Math.min(this.queue.length, Math.max(BASE_CHARS_PER_FRAME, Math.ceil(this.queue.length / 3)))
    const out = this.queue.slice(0, n)
    this.queue = this.queue.slice(n)
    this.emit(out)
    if (this.queue) this.pending = this.scheduler.raf(this.tick)
  }

  /** 立即吐尽全部缓冲(定稿/md 替换/中断前必须调用)。 */
  flush(): void {
    if (this.pending) {
      this.scheduler.caf(this.pending)
      this.pending = 0
    }
    if (!this.disposed && this.queue) {
      const out = this.queue
      this.queue = ''
      this.emit(out)
    }
  }

  /** 终止:取消排程、清空缓冲,此后 push/flush 均不再 emit。 */
  dispose(): void {
    this.disposed = true
    if (this.pending) {
      this.scheduler.caf(this.pending)
      this.pending = 0
    }
    this.queue = ''
  }
}
