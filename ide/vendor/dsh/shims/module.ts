// node:module → createRequire stub。
// DSH 链内唯一用途:dsh-llm/attribution.ts 在模块顶层读自身 package.json 的 version
// 拼 User-Agent。stub 对 *package.json 请求返回编译期写死的版本对象,其余一律抛错。
// 语义差异:版本号不再跟随 package.json 漂移(升级时需同步此处)。
const VERSION = '0.2.0-rc.2'

export function createRequire(_url: string | URL): (id: string) => unknown {
  return (id: string): unknown => {
    if (id.endsWith('package.json')) return { version: VERSION }
    throw new Error(`node:module shim: createRequire('${id}') is not available in the browser bundle`)
  }
}
