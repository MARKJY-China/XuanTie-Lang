// node:os → 抛错 stub。仅 dsh-sandbox/roots.ts 的 writableRoots() 函数体内引用,
// 浏览器链不会走到;走到即视为架构错误。
export function tmpdir(): never {
  throw new Error('node:os shim: tmpdir() is not available in the browser bundle')
}
