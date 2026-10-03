// node:fs → 抛错 stub。DSH 浏览器链不执行任何文件系统操作;
// 这些符号仅被 dsh-sandbox 的 roots.ts/diagnostics.ts 的函数体引用(模块顶层不调用),
// 浏览器侧若真走到这些路径说明误把沙箱执行带进了 WebView,必须当场炸开。
function unavailable(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`node:fs shim: ${name}() is not available in the browser bundle`)
  }
}

export const accessSync = unavailable('accessSync')
export const statSync = unavailable('statSync')
export const realpathSync = Object.assign(unavailable('realpathSync'), {
  native: unavailable('realpathSync.native'),
})
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }
