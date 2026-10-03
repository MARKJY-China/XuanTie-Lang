// node:async_hooks → 单全局单元格近似实现。
// 语义差异(重要):真 AsyncLocalStorage 按异步执行上下文隔离 store,交叉并发的
// 异步流各自看到自己的值;本 shim 只有一个全局槽位——
//   run(store, cb): 同步段内 getStore() 返回 store;cb 返回 thenable 时 store 保留
//     安装(直到下一次 run/enterWith 覆盖),因此单条异步流的跨 await getStore 仍正确,
//     但多条异步流交错时后启动的流会覆盖先启动流的 store(串台)。
//   enterWith(store): 直接安装全局值,无退出边界。
// DSH 链内仅 dsh-agent AgentRegistry 的 initiators/initiatorRuns 使用(getStore/run),
// 用于子代理编排的发起者归因;单 agent WebView 场景下近似行为可接受。
export class AsyncLocalStorage<T> {
  private store: { value: T | undefined } | undefined

  getStore(): T | undefined {
    return this.store?.value
  }

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store
    this.store = { value: store }
    const result = callback(...args)
    if (result === null || (typeof result !== 'object' && typeof result !== 'function') || typeof (result as { then?: unknown }).then !== 'function') {
      this.store = previous
    }
    return result
  }

  enterWith(store: T): void {
    this.store = { value: store }
  }

  disable(): void {
    this.store = undefined
  }
}
