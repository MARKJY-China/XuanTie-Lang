// node:path → 仅 isAbsolute。语义差异:Node 按平台分 win32/posix 两套;
// 此处合并判定(POSIX 绝对路径、Windows 盘符路径、UNC 路径均视为绝对)。
// DSH 链内仅 dsh-session 用它判断 session 元数据里的 cwd 形态,合并判定对两种平台都安全。
export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
