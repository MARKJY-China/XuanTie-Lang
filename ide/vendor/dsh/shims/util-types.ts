// node:util/types → isPromise。语义差异:原生 isPromise 只认真正的 Promise 实例
// (内部槽位判定),不认 thenable;此处按 thenable 判定,对 duck-typed thenable 会多判 true。
export function isPromise(value: unknown): value is Promise<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}
